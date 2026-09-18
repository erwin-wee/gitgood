import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepositoryManager } from '../../src/main/repo/manager';
import { GhClient } from '../../src/main/gh/gh';
import { SettingsSyncService } from '../../src/main/gh/settings-sync';
import { Store } from '../../src/main/store';
import { createFakeTools } from '../helpers/fake-tools';
import { createStubScenario, ghLauncherPath, readStubLog, type StubScenario } from '../helpers/gh-stub';

/** SettingsSyncService only ever calls `repos.list(false)`; a real RepositoryManager needs a live GitClient, which these tests have no need for. */
function fakeRepos(): RepositoryManager {
  return { list: async () => [] } as unknown as RepositoryManager;
}

async function withService(rules: Parameters<typeof createStubScenario>[0], fn: (service: SettingsSyncService, store: Store, scenario: StubScenario) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gg-sync-service-'));
  const scenario = await createStubScenario(rules);
  try {
    const store = new Store(dir);
    store.load();
    const tools = createFakeTools({ ghPath: ghLauncherPath(), env: scenario.env('GH') });
    const gh = new GhClient(tools);
    const service = new SettingsSyncService(store, gh, fakeRepos());
    await fn(service, store, scenario);
  } finally {
    await scenario.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('SettingsSyncService against the gh stub', () => {
  it('status reports disabled before sync is ever enabled, without calling gh', async () => {
    await withService([], async (service) => {
      const status = await service.status();
      expect(status).toMatchObject({ enabled: false, state: 'disabled', gistId: null });
      expect(status.localHash).toBeTruthy();
    });
  });

  it('enable reuses an existing gist found by its description', async () => {
    await withService([{ match: 'gists', stdout: JSON.stringify([{ id: 'existing123', description: 'GitGood settings', updated_at: '2026-01-01T00:00:00Z' }]) }], async (service, store) => {
      const result = await service.enable();
      expect(result.gistId).toBe('existing123');
      expect(store.getSettingsSync().gistId).toBe('existing123');
    });
  });

  it('enable creates a new gist when none is found, and records a hash', async () => {
    await withService(
      [
        { match: 'gists', stdout: '[]' },
        { match: 'gist create', stdout: 'https://gist.github.com/octocat/newgist123\n' },
      ],
      async (service, store) => {
        const result = await service.enable();
        expect(result.gistId).toBe('newgist123');
        expect(store.getSettingsSync()).toMatchObject({ gistId: 'newgist123' });
        expect(store.getSettingsSync().lastHash).toBeTruthy();
        expect(store.getSettingsSync().lastSyncedAt).toBeTruthy();
      },
    );
  });

  it('status reports gist-missing when the stored gist no longer resolves (404), the missing-gist recovery path', async () => {
    await withService([{ match: ['api', 'gists/gone123'], stderr: 'HTTP 404: Not Found', exitCode: 1 }], async (service, store) => {
      store.setSettingsSync({ gistId: 'gone123', lastSyncedAt: null, lastHash: null });
      const status = await service.status();
      expect(status.state).toBe('gist-missing');
      expect(status.remoteUpdatedAt).toBeNull();
    });
  });

  it('upload sends the current export over stdin and records the new hash and timestamp', async () => {
    await withService([{ match: 'gist edit', stdoutFromStdin: true }], async (service, store, scenario) => {
      store.setSettingsSync({ gistId: 'abc', lastSyncedAt: null, lastHash: null });
      await service.upload();
      expect(store.getSettingsSync().lastSyncedAt).toBeTruthy();
      expect(store.getSettingsSync().lastHash).toBeTruthy();
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['gist', 'edit', 'abc', '--filename', 'gitgood-settings.json', '-']);
    });
  });

  it('download applies the remote export through Store.importSettings and records the new hash', async () => {
    const remoteText = JSON.stringify({ schema: 1, app: 'gitgood', version: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', platform: process.platform, preferences: { theme: 'dark' } });
    await withService([{ match: 'gist view', stdout: remoteText }], async (service, store) => {
      store.setSettingsSync({ gistId: 'abc', lastSyncedAt: null, lastHash: null });
      const settings = await service.download('merge');
      expect(settings.theme).toBe('dark');
      expect(store.getSettingsSync().lastHash).toBeTruthy();
    });
  });

  it('download refuses and does not update sync state when the gist content is not a valid export', async () => {
    await withService([{ match: 'gist view', stdout: '{"not":"an export"}' }], async (service, store) => {
      store.setSettingsSync({ gistId: 'abc', lastSyncedAt: null, lastHash: 'previous' });
      await expect(service.download('merge')).rejects.toThrow();
      expect(store.getSettingsSync().lastHash).toBe('previous');
    });
  });

  it('disable clears the local reference without deleting the gist by default', async () => {
    await withService([], async (service, store) => {
      store.setSettingsSync({ gistId: 'abc', lastSyncedAt: '2026-01-01T00:00:00Z', lastHash: 'h' });
      await service.disable(false);
      expect(store.getSettingsSync()).toEqual({ gistId: null, lastSyncedAt: null, lastHash: null });
    });
  });

  it('disable(true) also deletes the gist', async () => {
    await withService([{ match: 'gist delete', stdout: '' }], async (service, store, scenario) => {
      store.setSettingsSync({ gistId: 'abc', lastSyncedAt: '2026-01-01T00:00:00Z', lastHash: 'h' });
      await service.disable(true);
      expect(store.getSettingsSync().gistId).toBeNull();
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['gist', 'delete', 'abc']);
    });
  });
});
