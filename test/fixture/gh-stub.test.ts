import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createStubScenario, ghLauncherPath, readStubLog } from '../helpers/gh-stub';

// Node refuses to spawn a .cmd/.bat file directly without `shell: true` (the
// fix for CVE-2024-27980); it throws EINVAL synchronously instead. Everywhere
// else in the app that indirection goes through exec()'s buildWindowsCmdInvocation,
// but this file drives the launcher directly to test the launcher itself.
const winOpts = process.platform === 'win32' ? { shell: true } : {};

describe('gh-stub launcher', () => {
  it('replays the matching rule and logs the invocation', async () => {
    const scenario = await createStubScenario([{ match: ['pr', 'list'], stdout: '[{"number":1}]\n', name: 'pr-list' }]);
    try {
      const out = execFileSync(ghLauncherPath(), ['pr', 'list', '--repo', 'o/r'], { env: { ...process.env, ...scenario.env('GH') }, ...winOpts }).toString();
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
        execFileSync(ghLauncherPath(), ['repo', 'view'], { env: { ...process.env, ...scenario.env('GH') }, ...winOpts });
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
      execFileSync(ghLauncherPath(), ['whatever'], { env: process.env, ...winOpts });
    } catch (err) {
      error = err as Error & { status?: number };
    }
    expect(error).not.toBeNull();
    expect(error!.status).toBe(99);
  });
});
