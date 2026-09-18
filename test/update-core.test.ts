import { describe, expect, it } from 'vitest';
import { canInstall, compareVersions, detectDisabledReason, isEligibleForChannel, isNewerVersion, reduceUpdateState, type ReleaseInfo } from '../src/main/update/update-core';
import type { UpdateState } from '../src/shared/types';

function release(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return { version: '1.2.0', releaseDate: '2026-01-01T00:00:00Z', notes: 'Notes', url: 'https://github.com/erwin-wee/gitgood/releases/tag/v1.2.0', prerelease: false, draft: false, ...overrides };
}

describe('compareVersions / isNewerVersion', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(true);
  });

  it('treats equal versions as equal regardless of a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('never offers a downgrade', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false);
  });

  it('ranks a prerelease of the same core version below the release', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
    expect(isNewerVersion('1.2.0-beta.1', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.2.0-beta.1')).toBe(false);
  });

  it('compares prerelease suffixes of the same core version lexically', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0-beta.2')).toBeLessThan(0);
  });
});

describe('isEligibleForChannel', () => {
  it('never offers a draft, on any channel', () => {
    expect(isEligibleForChannel({ prerelease: false, draft: true }, 'stable')).toBe(false);
    expect(isEligibleForChannel({ prerelease: false, draft: true }, 'beta')).toBe(false);
  });

  it('excludes a prerelease on the stable channel', () => {
    expect(isEligibleForChannel({ prerelease: true, draft: false }, 'stable')).toBe(false);
  });

  it('includes a prerelease on the beta channel', () => {
    expect(isEligibleForChannel({ prerelease: true, draft: false }, 'beta')).toBe(true);
  });

  it('includes an ordinary release on both channels', () => {
    expect(isEligibleForChannel({ prerelease: false, draft: false }, 'stable')).toBe(true);
    expect(isEligibleForChannel({ prerelease: false, draft: false }, 'beta')).toBe(true);
  });
});

describe('reduceUpdateState', () => {
  const idle: UpdateState = { status: 'idle' };

  it('check-start moves idle to checking', () => {
    expect(reduceUpdateState(idle, { type: 'check-start' })).toEqual({ status: 'checking' });
  });

  it('check-result with a newer eligible release produces available, not dismissed', () => {
    const next = reduceUpdateState({ status: 'checking' }, { type: 'check-result', release: release(), currentVersion: '1.0.0', channel: 'stable' });
    expect(next).toEqual({ status: 'available', version: '1.2.0', releaseDate: '2026-01-01T00:00:00Z', notes: 'Notes', url: 'https://github.com/erwin-wee/gitgood/releases/tag/v1.2.0', prerelease: false, dismissed: false });
  });

  it('check-result with no release reports up-to-date', () => {
    expect(reduceUpdateState({ status: 'checking' }, { type: 'check-result', release: null, currentVersion: '1.0.0', channel: 'stable' })).toEqual({ status: 'up-to-date' });
  });

  it('check-result with an older or equal release reports up-to-date (no downgrade offered)', () => {
    expect(reduceUpdateState({ status: 'checking' }, { type: 'check-result', release: release({ version: '1.0.0' }), currentVersion: '1.2.0', channel: 'stable' })).toEqual({ status: 'up-to-date' });
    expect(reduceUpdateState({ status: 'checking' }, { type: 'check-result', release: release({ version: '1.2.0' }), currentVersion: '1.2.0', channel: 'stable' })).toEqual({ status: 'up-to-date' });
  });

  it('check-result with a stable-channel prerelease reports up-to-date', () => {
    expect(reduceUpdateState({ status: 'checking' }, { type: 'check-result', release: release({ version: '1.3.0-beta.1', prerelease: true }), currentVersion: '1.2.0', channel: 'stable' })).toEqual({ status: 'up-to-date' });
  });

  it('check-result with a beta-channel prerelease reports available', () => {
    const next = reduceUpdateState({ status: 'checking' }, { type: 'check-result', release: release({ version: '1.3.0-beta.1', prerelease: true }), currentVersion: '1.2.0', channel: 'beta' });
    expect(next).toMatchObject({ status: 'available', version: '1.3.0-beta.1', prerelease: true });
  });

  it('check-error reports the error with a manual URL', () => {
    expect(reduceUpdateState({ status: 'checking' }, { type: 'check-error', message: 'boom', manualUrl: 'https://x' })).toEqual({ status: 'error', message: 'boom', manualUrl: 'https://x' });
  });

  it('dismiss marks only the matching available version as dismissed', () => {
    const available: UpdateState = { status: 'available', version: '1.2.0', releaseDate: null, notes: null, url: 'https://x', prerelease: false, dismissed: false };
    expect(reduceUpdateState(available, { type: 'dismiss', version: '1.2.0' })).toEqual({ ...available, dismissed: true });
    expect(reduceUpdateState(available, { type: 'dismiss', version: '9.9.9' })).toEqual(available);
    expect(reduceUpdateState(idle, { type: 'dismiss', version: '1.2.0' })).toEqual(idle);
  });

  it('a disabled state never leaves disabled', () => {
    const disabled: UpdateState = { status: 'disabled', reason: 'nope', manualUrl: null };
    expect(reduceUpdateState(disabled, { type: 'check-start' })).toEqual(disabled);
    expect(reduceUpdateState(disabled, { type: 'check-result', release: release(), currentVersion: '1.0.0', channel: 'stable' })).toEqual(disabled);
    expect(reduceUpdateState(disabled, { type: 'check-error', message: 'x', manualUrl: null })).toEqual(disabled);
  });

  it('disabled event always wins, from any prior state', () => {
    expect(reduceUpdateState(idle, { type: 'disabled', reason: 'dev build', manualUrl: 'https://x' })).toEqual({ status: 'disabled', reason: 'dev build', manualUrl: 'https://x' });
  });
});

describe('detectDisabledReason', () => {
  const packaged = { isPackaged: true, platform: 'linux' as NodeJS.Platform, portableExecutableDir: undefined, appImagePath: undefined, appImageWritable: false };

  it('disables unpackaged (development) builds', () => {
    expect(detectDisabledReason({ ...packaged, isPackaged: false })).toContain('Updates unavailable in this build');
  });

  it('disables portable Windows builds', () => {
    expect(detectDisabledReason({ ...packaged, platform: 'win32', portableExecutableDir: 'C:\\Portable' })).toMatch(/portable/i);
  });

  it('disables a read-only AppImage', () => {
    expect(detectDisabledReason({ ...packaged, appImagePath: '/mnt/ro/GitGood.AppImage', appImageWritable: false })).toMatch(/read-only/i);
  });

  it('allows a writable AppImage through', () => {
    expect(detectDisabledReason({ ...packaged, appImagePath: '/home/user/GitGood.AppImage', appImageWritable: true })).toBeNull();
  });

  it('disables macOS (unsigned builds)', () => {
    expect(detectDisabledReason({ ...packaged, platform: 'darwin' })).toMatch(/unsigned/i);
  });

  it('allows a packaged, non-portable, non-AppImage, non-macOS build through', () => {
    expect(detectDisabledReason(packaged)).toBeNull();
  });
});

describe('canInstall (install safety gate)', () => {
  it('allows installing when nothing is in progress', () => {
    expect(canInstall({ operationKind: 'none', aiActive: false })).toEqual({ ok: true });
  });

  it('allows installing during a bisect (not considered blocking)', () => {
    expect(canInstall({ operationKind: 'bisect', aiActive: false })).toEqual({ ok: true });
  });

  it('refuses during a merge/rebase/cherry-pick/revert', () => {
    for (const kind of ['merge', 'rebase', 'cherry-pick', 'revert'] as const) {
      const result = canInstall({ operationKind: kind, aiActive: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(kind);
    }
  });

  it('refuses while an AI task is active', () => {
    const result = canInstall({ operationKind: 'none', aiActive: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/AI/);
  });
});
