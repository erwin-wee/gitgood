import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCheckCommand, runPostResolveCheck } from '../src/main/ai/check-runner';

const SCRIPT_DIR = mkdtempSync(join(tmpdir(), 'gitgood-check-'));

/**
 * A shell command that runs `source` under node. The script goes in a file
 * rather than `node -e "..."` because the check runs through `/bin/sh -c` on
 * POSIX and `cmd.exe /d /s /c` on Windows, and the two disagree about nested
 * quotes -- inline JS string literals get mangled on Windows.
 */
function nodeScript(name: string, source: string): string {
  const file = join(SCRIPT_DIR, `${name}.js`);
  writeFileSync(file, source, 'utf8');
  return `"${process.execPath}" "${file}"`;
}

describe('resolveCheckCommand (trust gate)', () => {
  it('never runs a repository command that has not been explicitly trusted', () => {
    expect(resolveCheckCommand({ userCommand: null, repoCommand: 'npm run typecheck', fromRepoEnabled: true, trusted: undefined })).toBeNull();
  });

  it('never runs a repository command the user declined', () => {
    expect(resolveCheckCommand({ userCommand: null, repoCommand: 'npm run typecheck', fromRepoEnabled: true, trusted: false })).toBeNull();
  });

  it('never runs a repository command when the setting is off, even if trusted', () => {
    expect(resolveCheckCommand({ userCommand: null, repoCommand: 'npm run typecheck', fromRepoEnabled: false, trusted: true })).toBeNull();
  });

  it('uses the trusted repository command over the user setting when both are present and the setting is on', () => {
    expect(resolveCheckCommand({ userCommand: 'npm run lint', repoCommand: 'npm run typecheck', fromRepoEnabled: true, trusted: true })).toEqual({ command: 'npm run typecheck', fromRepo: true });
  });

  it('falls back to the user setting when there is no repository command', () => {
    expect(resolveCheckCommand({ userCommand: 'npm run lint', repoCommand: null, fromRepoEnabled: true, trusted: true })).toEqual({ command: 'npm run lint', fromRepo: false });
  });

  it('falls back to the user setting when the repository command is untrusted', () => {
    expect(resolveCheckCommand({ userCommand: 'npm run lint', repoCommand: 'npm run typecheck', fromRepoEnabled: true, trusted: undefined })).toEqual({ command: 'npm run lint', fromRepo: false });
  });

  it('returns null when nothing is configured', () => {
    expect(resolveCheckCommand({ userCommand: null, repoCommand: null, fromRepoEnabled: true, trusted: true })).toBeNull();
  });

  it('treats a blank user command as unconfigured', () => {
    expect(resolveCheckCommand({ userCommand: '   ', repoCommand: null, fromRepoEnabled: true, trusted: undefined })).toBeNull();
  });
});

describe('runPostResolveCheck', () => {
  it('reports a passing command', async () => {
    const result = await runPostResolveCheck(nodeScript('pass', 'process.exit(0);'), process.cwd(), process.env, false);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.fromRepo).toBe(false);
  });

  it('reports a failing exit code and captures output', async () => {
    const result = await runPostResolveCheck(nodeScript('fail', 'console.log("boom"); process.exit(2);'), process.cwd(), process.env, true);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.fromRepo).toBe(true);
    expect(result.outputTail).toContain('boom');
  });

  it('reports a timeout, killing the process and capping duration', async () => {
    // The production 5-minute timeout is far too slow for a test; the optional last argument
    // overrides it so this exercises the exact same timeout/kill path with a short deadline.
    const result = await runPostResolveCheck(nodeScript('sleep', 'setTimeout(() => {}, 5000);'), process.cwd(), process.env, false, undefined, 50);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.outputTail).toContain('timed out');
  }, 5000);

  it('caps the output tail at 4,000 characters', async () => {
    const result = await runPostResolveCheck(nodeScript('big', 'process.stdout.write("x".repeat(5000));'), process.cwd(), process.env, false);
    expect(result.outputTail.length).toBeLessThanOrEqual(4000);
    expect(result.outputTail.endsWith('x'.repeat(100))).toBe(true);
  });

  it('reports cancellation via an abort signal without treating it as a timeout', async () => {
    const controller = new AbortController();
    const promise = runPostResolveCheck(nodeScript('sleep2', 'setTimeout(() => {}, 5000);'), process.cwd(), process.env, false, controller.signal);
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});
