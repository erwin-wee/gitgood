import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type RepositoryInfo, type SettingsExport } from '../src/shared/types';
import {
  applyRepositoryImport,
  buildImportPreview,
  buildIntegrationsPatch,
  buildPortableIntegrations,
  buildPortablePreferences,
  buildPortableRepositories,
  buildPreferencesPatch,
  buildSettingsExport,
  normalizeExportPath,
  planRepositoryImport,
  resolveSyncState,
  stableHash,
  validateSettingsExport,
} from '../src/main/settings/sync-core';

function repo(overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  return { id: 'r1', path: '/home/user/repo', name: 'repo', alias: null, missing: false, github: null, lastOpened: 0, indicator: null, worktreeOf: null, parentRepoId: null, ...overrides };
}

// Every key that must never appear anywhere in an exported file, however deeply nested.
const FORBIDDEN_SUBSTRINGS = ['hasApiKey', 'claudeCliPath', 'anthropicApiKey', 'sk-ant-', '"gitPath"', '"ghPath"', 'gistId', 'windowState', '"window"', 'trustedRepoConfigs', 'inboxCache', 'reviewRuns'];

describe('buildSettingsExport / the allowlist', () => {
  it('never includes a forbidden key or secret, with every section selected', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, gitPath: '/usr/bin/git', ghPath: '/usr/bin/gh', ai: { ...DEFAULT_SETTINGS.ai, hasApiKey: true, claudeCliPath: '/usr/local/bin/claude' } };
    const repositories = [repo({ github: { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' } })];
    const data = buildSettingsExport({ sections: ['preferences', 'repositories', 'integrations'], settings, repositories, appVersion: '1.0.0', platform: 'linux', now: '2026-01-01T00:00:00Z' });
    const json = JSON.stringify(data);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) expect(json).not.toContain(forbidden);
    expect(json).not.toContain('/usr/bin/git');
    expect(json).not.toContain('/usr/bin/gh');
    expect(json).not.toContain('/usr/local/bin/claude');
  });

  it('exports only the preferences section when only Preferences is selected, with no repository or integration paths', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, externalEditor: 'code', customEditorPath: '/opt/code', theme: 'dark' };
    const data = buildSettingsExport({ sections: ['preferences'], settings, repositories: [repo()], appVersion: '1.0.0', platform: 'linux' });
    expect(data.preferences).toBeTruthy();
    expect(data.repositories).toBeUndefined();
    expect(data.integrations).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('/opt/code');
    expect(JSON.stringify(data)).not.toContain('/home/user/repo');
  });

  it('includes the schema version, app id, platform and timestamp', () => {
    const data = buildSettingsExport({ sections: [], settings: DEFAULT_SETTINGS, repositories: [], appVersion: '2.3.4', platform: 'darwin', now: '2026-05-01T00:00:00Z' });
    expect(data).toMatchObject({ schema: 1, app: 'gitgood', version: '2.3.4', platform: 'darwin', exportedAt: '2026-05-01T00:00:00Z' });
  });

  it('normalizes backslashes to forward slashes in exported repository paths', () => {
    expect(normalizeExportPath('C:\\Users\\erwin\\repo')).toBe('C:/Users/erwin/repo');
    const out = buildPortableRepositories([repo({ path: 'C:\\Users\\erwin\\repo' })]);
    expect(out[0].path).toBe('C:/Users/erwin/repo');
  });

  it('excludes worktree and submodule entries from the repositories section', () => {
    const out = buildPortableRepositories([repo({ id: 'a' }), repo({ id: 'b', worktreeOf: 'a' }), repo({ id: 'c', parentRepoId: 'a' })]);
    expect(out).toHaveLength(1);
  });

  it('portable preferences carry only the allowlisted ai fields', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, hasApiKey: true, claudeCliPath: '/bin/claude', provider: 'claude-cli', model: 'x', effort: 'max' } };
    const prefs = buildPortablePreferences(settings);
    expect(prefs.ai).toEqual({ provider: 'claude-cli', model: 'x', effort: 'max', autoStageAfterResolve: settings.ai.autoStageAfterResolve, reviewStrictness: settings.ai.reviewStrictness, reviewMaxFiles: settings.ai.reviewMaxFiles, reviewPostFooter: settings.ai.reviewPostFooter });
    expect((prefs.ai as unknown as Record<string, unknown>).hasApiKey).toBeUndefined();
    expect((prefs.ai as unknown as Record<string, unknown>).claudeCliPath).toBeUndefined();
  });

  it('portable integrations carry only editor/shell fields', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, externalEditor: 'code', customEditorPath: '/opt/code', shell: 'zsh', customShellPath: null };
    expect(buildPortableIntegrations(settings)).toEqual({ externalEditor: 'code', customEditorPath: '/opt/code', shell: 'zsh', customShellPath: null });
  });
});

describe('validateSettingsExport', () => {
  it('accepts a well-formed export', () => {
    const data = buildSettingsExport({ sections: ['preferences'], settings: DEFAULT_SETTINGS, repositories: [], appVersion: '1.0.0', platform: 'linux' });
    const result = validateSettingsExport(JSON.parse(JSON.stringify(data)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.preferences?.theme).toBe('system');
  });

  it('refuses a file that is not a GitGood export', () => {
    const result = validateSettingsExport({ hello: 'world' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a valid GitGood settings export/);
  });

  it('refuses a newer schema version and asks the user to update', () => {
    const result = validateSettingsExport({ schema: 99, app: 'gitgood', version: '9.9.9', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/newer version of GitGood/);
  });

  it('refuses malformed field types in the envelope', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: 123, exportedAt: '2026-01-01T00:00:00Z', platform: 'linux' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version');
  });

  it('accepts a partial preferences object (only a theme change) and leaves the rest absent', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', preferences: { theme: 'dark' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.preferences).toEqual({ theme: 'dark' });
      expect(result.warnings).toEqual([]);
    }
  });

  it('drops unknown top-level and preference keys with a warning instead of refusing', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', mystery: 1, preferences: { theme: 'dark', notAThing: true } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.preferences).toEqual({ theme: 'dark' });
      expect(result.warnings.some((w) => w.includes('mystery'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('notAThing'))).toBe(true);
    }
  });

  it('drops a wrong-typed individual preference field with a warning, keeping the rest', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', preferences: { theme: 'dark', diffFontSize: 'huge' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.preferences).toEqual({ theme: 'dark' });
      expect(result.warnings.some((w) => w.includes('diffFontSize'))).toBe(true);
    }
  });

  it('never round-trips ai.hasApiKey or ai.claudeCliPath even if present in the raw file', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', preferences: { ai: { provider: 'anthropic', hasApiKey: true, claudeCliPath: '/bin/x' } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.preferences?.ai).toEqual({ provider: 'anthropic' });
      expect(JSON.stringify(result.data)).not.toContain('hasApiKey');
      expect(JSON.stringify(result.data)).not.toContain('/bin/x');
    }
  });

  it('rejects a non-array repositories field', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', repositories: 'nope' });
    expect(result.ok).toBe(false);
  });

  it('skips a malformed repository entry with a warning', () => {
    const result = validateSettingsExport({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', repositories: [{ path: '/a' }, { alias: 'no-path' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repositories).toEqual([{ path: '/a', alias: null, github: null }]);
      expect(result.warnings.some((w) => w.includes('repositories[1]'))).toBe(true);
    }
  });
});

describe('buildPreferencesPatch (merge vs replace)', () => {
  const current: AppSettings = { ...DEFAULT_SETTINGS, theme: 'light', diffFontSize: 16, gitPath: '/usr/bin/git', ai: { ...DEFAULT_SETTINGS.ai, hasApiKey: true, claudeCliPath: '/bin/claude', model: 'current-model' } };

  it('merge only overlays fields present in the file; theme changes, everything else is untouched', () => {
    const patch = buildPreferencesPatch(current, { theme: 'dark' }, 'merge');
    expect(patch.theme).toBe('dark');
    expect(patch.diffFontSize).toBe(16);
    expect(patch.gitPath).toBeUndefined();
    expect(patch.ai).toMatchObject({ hasApiKey: true, claudeCliPath: '/bin/claude', model: 'current-model' });
  });

  it('replace resets omitted preference fields to defaults but leaves non-portable fields alone', () => {
    const patch = buildPreferencesPatch(current, { theme: 'dark' }, 'replace');
    expect(patch.theme).toBe('dark');
    expect(patch.diffFontSize).toBe(DEFAULT_SETTINGS.diffFontSize);
    expect(patch.gitPath).toBeUndefined();
    expect(patch.ai).toMatchObject({ hasApiKey: true, claudeCliPath: '/bin/claude', model: DEFAULT_SETTINGS.ai.model });
  });
});

describe('buildIntegrationsPatch (other-platform skip)', () => {
  const current: AppSettings = { ...DEFAULT_SETTINGS, externalEditor: 'code', customEditorPath: '/usr/bin/code' };

  it('skips a custom editor path from a different platform, with a warning, keeping the current value', () => {
    const { patch, warnings } = buildIntegrationsPatch(current, { externalEditor: 'custom', customEditorPath: 'C:\\Program Files\\Editor\\editor.exe' }, 'merge', 'win32', 'linux');
    expect(patch.customEditorPath).toBe(current.customEditorPath);
    expect(patch.externalEditor).toBe('custom');
    expect(warnings.some((w) => w.includes('customEditorPath'))).toBe(true);
  });

  it('keeps a custom path when the platform matches', () => {
    const { patch, warnings } = buildIntegrationsPatch(current, { customEditorPath: '/usr/bin/subl' }, 'merge', 'linux', 'linux');
    expect(patch.customEditorPath).toBe('/usr/bin/subl');
    expect(warnings).toEqual([]);
  });
});

describe('planRepositoryImport / applyRepositoryImport', () => {
  it('counts new repositories as adds', () => {
    const plan = planRepositoryImport([], [{ path: '/a/b', alias: null, github: null }]);
    expect(plan).toMatchObject({ adds: 1, changes: 0, skipped: 0 });
  });

  it('counts a matching repository with a different alias as a change, and an identical one as skipped', () => {
    const current = [repo({ id: '1', path: '/a/b', alias: 'old' }), repo({ id: '2', path: '/c/d', alias: 'same' })];
    const plan = planRepositoryImport(current, [
      { path: '/a/b', alias: 'new', github: null },
      { path: '/c/d', alias: 'same', github: null },
    ]);
    expect(plan).toMatchObject({ adds: 0, changes: 1, skipped: 1 });
  });

  it('matches paths case-insensitively across slash styles', () => {
    const current = [repo({ path: 'C:/Users/erwin/repo' })];
    const plan = planRepositoryImport(current, [{ path: 'c:\\users\\erwin\\repo', alias: null, github: null }]);
    expect(plan).toMatchObject({ adds: 0, skipped: 1 });
  });

  it('applyRepositoryImport adds a new repository, marking it missing when its path does not exist', () => {
    const next = applyRepositoryImport([], [{ path: '/does/not/exist', alias: 'x', github: null }], (p) => `id-${p}`, () => false);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'id-/does/not/exist', path: '/does/not/exist', alias: 'x', missing: true });
  });

  it('applyRepositoryImport updates alias/github on an existing repository without touching other fields', () => {
    const current = [repo({ id: '1', path: '/a/b', alias: 'old', lastOpened: 123 })];
    const next = applyRepositoryImport(current, [{ path: '/a/b', alias: 'new', github: null }], () => 'unused', () => true);
    expect(next[0]).toMatchObject({ id: '1', alias: 'new', lastOpened: 123 });
  });

  it('never removes a repository absent from the import (repository import is additive)', () => {
    const current = [repo({ id: '1', path: '/a/b' })];
    const next = applyRepositoryImport(current, [], () => 'unused', () => true);
    expect(next).toEqual(current);
  });
});

describe('buildImportPreview', () => {
  const current = DEFAULT_SETTINGS;

  it('reports missing repository paths without failing', () => {
    const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', repositories: [{ path: '/gone', alias: null, github: null }] };
    const preview = buildImportPreview({ file, currentSettings: current, currentRepositories: [], pathExists: () => false, filePlatform: 'linux', thisPlatform: 'linux', validationWarnings: [] });
    expect(preview.missingRepositories).toEqual(['/gone']);
    expect(preview.sections).toEqual([{ name: 'repositories', adds: 1, changes: 0, skipped: 0 }]);
  });

  it('counts a preference section change only for fields that actually differ', () => {
    const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux', preferences: { theme: current.theme, diffFontSize: current.diffFontSize + 1 } };
    const preview = buildImportPreview({ file, currentSettings: current, currentRepositories: [], pathExists: () => true, filePlatform: 'linux', thisPlatform: 'linux', validationWarnings: [] });
    expect(preview.sections).toEqual([{ name: 'preferences', adds: 0, changes: 1, skipped: 0 }]);
  });

  it('surfaces validation warnings alongside the section counts', () => {
    const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: 'linux' };
    const preview = buildImportPreview({ file, currentSettings: current, currentRepositories: [], pathExists: () => true, filePlatform: 'linux', thisPlatform: 'linux', validationWarnings: ['mystery: unknown top-level field, ignored'] });
    expect(preview.warnings).toEqual(['mystery: unknown top-level field, ignored']);
  });
});

describe('resolveSyncState', () => {
  it('reports gist-missing when the referenced gist no longer exists', () => {
    expect(resolveSyncState({ gistFound: false, localHash: 'a', remoteHash: null, lastHash: null })).toBe('gist-missing');
  });

  it('reports up-to-date when neither side changed since the last sync', () => {
    expect(resolveSyncState({ gistFound: true, localHash: 'h', remoteHash: 'h', lastHash: 'h' })).toBe('up-to-date');
  });

  it('reports remote-newer when only the remote hash changed', () => {
    expect(resolveSyncState({ gistFound: true, localHash: 'h', remoteHash: 'new', lastHash: 'h' })).toBe('remote-newer');
  });

  it('reports local-newer when only the local hash changed', () => {
    expect(resolveSyncState({ gistFound: true, localHash: 'new', remoteHash: 'h', lastHash: 'h' })).toBe('local-newer');
  });

  it('reports diverged when both sides changed', () => {
    expect(resolveSyncState({ gistFound: true, localHash: 'new-local', remoteHash: 'new-remote', lastHash: 'h' })).toBe('diverged');
  });
});

describe('stableHash', () => {
  it('is deterministic and sensitive to content', () => {
    expect(stableHash('a')).toBe(stableHash('a'));
    expect(stableHash('a')).not.toBe(stableHash('b'));
  });
});
