import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { flagOutdated, ToolLocator } from '../../src/main/tools';
import type { Store } from '../../src/main/store';

function hasOnPath(name: string, args: string[]): boolean {
  try {
    execFileSync(name, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Store is only referenced by type in tools.ts (no runtime import), so a minimal stand-in with just getSettings() is enough. */
function fakeStore(): Store {
  return { getSettings: () => DEFAULT_SETTINGS } as unknown as Store;
}

describe.skipIf(!hasOnPath('gpg', ['--version']))('ToolLocator: gpg detection', () => {
  it('reports gpg as installed with a parsed version', async () => {
    const locator = new ToolLocator(fakeStore());
    await locator.ensureLocated();
    const state = locator.current();
    expect(state.gpg.installed).toBe(true);
    expect(state.gpg.path).toBeTruthy();
    expect(state.gpg.version).toMatch(/\d+\.\d+/);
  });
});

describe.skipIf(!hasOnPath('ssh-keygen', ['-V']))('ToolLocator: ssh-keygen detection', () => {
  it('reports ssh-keygen as installed by presence on PATH', async () => {
    const locator = new ToolLocator(fakeStore());
    await locator.ensureLocated();
    const state = locator.current();
    expect(state.sshKeygen.installed).toBe(true);
    expect(state.sshKeygen.path).toBeTruthy();
  });
});

describe.skipIf(!hasOnPath('git', ['--version']))('ToolLocator: pre-scan state', () => {
  /**
   * `current()` answers synchronously from whatever the last scan found, so
   * before `ensureLocated()` resolves it reports every tool as missing. Any
   * caller that surfaces this state to the user (the `app.tools` IPC handler,
   * which the renderer uses to decide whether to show the "GitGood needs Git
   * to run" setup screen) has to await the scan first.
   */
  it('reports git as missing until the scan has run, and installed afterwards', async () => {
    const locator = new ToolLocator(fakeStore());
    expect(locator.current().git.installed).toBe(false);
    await locator.ensureLocated();
    expect(locator.current().git.installed).toBe(true);
  });
});

describe('flagOutdated', () => {
  const info = (version: string | null, installed = true) => ({ installed, version, path: '/usr/bin/x', error: null });

  it('flags a version below the minimum, comparing numerically (2.9 < 2.30)', () => {
    expect(flagOutdated(info('2.29.9'), '2.30.0')).toMatchObject({ outdated: true, minVersion: '2.30.0' });
    expect(flagOutdated(info('2.9.5'), '2.30.0').outdated).toBe(true);
  });

  it('accepts the minimum itself, newer versions, and vendor-suffixed git versions', () => {
    expect(flagOutdated(info('2.30.0'), '2.30.0').outdated).toBeUndefined();
    expect(flagOutdated(info('2.100.0'), '2.30.0').outdated).toBeUndefined();
    expect(flagOutdated(info('2.45.1.windows.1'), '2.30.0').outdated).toBeUndefined();
    expect(flagOutdated(info('2.39.3'), '2.30.0').outdated).toBeUndefined();
  });

  it('does not flag a tool that is missing or has an unparseable version', () => {
    expect(flagOutdated(info(null), '2.30.0').outdated).toBeUndefined();
    expect(flagOutdated(info('1.0.0', false), '2.30.0').outdated).toBeUndefined();
  });
});
