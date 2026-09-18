import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { ToolLocator } from '../../src/main/tools';
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
