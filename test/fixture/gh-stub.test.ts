import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createStubScenario, ghLauncherPath, readStubLog } from '../helpers/gh-stub';

describe('gh-stub launcher', () => {
  it('replays the matching rule and logs the invocation', async () => {
    const scenario = await createStubScenario([{ match: ['pr', 'list'], stdout: '[{"number":1}]\n', name: 'pr-list' }]);
    try {
      const out = execFileSync(ghLauncherPath(), ['pr', 'list', '--repo', 'o/r'], { env: { ...process.env, ...scenario.env('GH') } }).toString();
      expect(out).toBe('[{"number":1}]\n');
      const log = await readStubLog(scenario.logPath);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ tool: 'gh', matched: true, rule: 'pr-list' });
    } finally {
      await scenario.dispose();
    }
  });

  it('exits 99 and logs a miss when no rule matches', async () => {
    const scenario = await createStubScenario([{ match: 'pr list', stdout: 'ok' }]);
    try {
      let error: (Error & { status?: number; stderr?: Buffer }) | null = null;
      try {
        execFileSync(ghLauncherPath(), ['repo', 'view'], { env: { ...process.env, ...scenario.env('GH') } });
      } catch (err) {
        error = err as Error & { status?: number; stderr?: Buffer };
      }
      expect(error).not.toBeNull();
      expect(error!.status).toBe(99);
      expect(error!.stderr!.toString()).toContain('no rule matched');
      const log = await readStubLog(scenario.logPath);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ matched: false });
    } finally {
      await scenario.dispose();
    }
  });

  it('exits 99 when no scenario is configured at all', () => {
    let error: (Error & { status?: number }) | null = null;
    try {
      execFileSync(ghLauncherPath(), ['whatever'], { env: process.env });
    } catch (err) {
      error = err as Error & { status?: number };
    }
    expect(error).not.toBeNull();
    expect(error!.status).toBe(99);
  });
});
