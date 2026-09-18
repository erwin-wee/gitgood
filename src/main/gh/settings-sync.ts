import type { AppSettings, SettingsSyncStatus } from '@shared/types';
import { log } from '../logger';
import type { RepositoryManager } from '../repo/manager';
import { GIST_DESCRIPTION, GIST_FILENAME, resolveSyncState, stableHash, validateSettingsExport } from '../settings/sync-core';
import type { Store } from '../store';
import type { GhClient } from './gh';

/**
 * Sync with GitHub gist: creates or reuses a secret gist (found by its fixed
 * description, since `gh gist list` output is not JSON in all versions),
 * uploads/downloads the same allowlist export the file-based flow produces,
 * and compares content hashes to decide which side changed since the last
 * sync — never merging silently. No background sync: every method here runs
 * only in response to a user action.
 */
export class SettingsSyncService {
  constructor(
    private readonly store: Store,
    private readonly gh: GhClient,
    private readonly repos: RepositoryManager,
  ) {}

  private async currentExportText(): Promise<string> {
    const repositories = await this.repos.list(false);
    const data = this.store.buildExport(['preferences', 'repositories', 'integrations'], repositories);
    return JSON.stringify(data, null, 2);
  }

  async status(): Promise<SettingsSyncStatus> {
    const sync = this.store.getSettingsSync();
    const localHash = stableHash(await this.currentExportText());
    if (!sync.gistId) {
      return { enabled: false, gistId: null, lastSyncedAt: null, remoteUpdatedAt: null, localHash, remoteHash: null, state: 'disabled' };
    }
    const meta = await this.gh.gistMetadata(sync.gistId);
    if (!meta) {
      return { enabled: true, gistId: sync.gistId, lastSyncedAt: sync.lastSyncedAt, remoteUpdatedAt: null, localHash, remoteHash: null, state: 'gist-missing' };
    }
    const remoteText = await this.gh.gistView(sync.gistId, GIST_FILENAME);
    const remoteHash = remoteText === null ? null : stableHash(remoteText);
    const state = remoteText === null ? 'gist-missing' : resolveSyncState({ gistFound: true, localHash, remoteHash, lastHash: sync.lastHash });
    return { enabled: true, gistId: sync.gistId, lastSyncedAt: sync.lastSyncedAt, remoteUpdatedAt: meta.updatedAt, localHash, remoteHash, state };
  }

  /** Reuses an existing "GitGood settings" gist (e.g. enabled from another machine) or creates a new one. Also used to recover from a deleted gist. */
  async enable(): Promise<{ gistId: string }> {
    const existing = await this.gh.gistFind(GIST_DESCRIPTION);
    if (existing) {
      this.store.setSettingsSync({ gistId: existing.id, lastSyncedAt: null, lastHash: null });
      return { gistId: existing.id };
    }
    const text = await this.currentExportText();
    const id = await this.gh.gistCreate(text, GIST_FILENAME, GIST_DESCRIPTION);
    this.store.setSettingsSync({ gistId: id, lastSyncedAt: new Date().toISOString(), lastHash: stableHash(text) });
    return { gistId: id };
  }

  async disable(deleteGist: boolean): Promise<void> {
    const sync = this.store.getSettingsSync();
    if (deleteGist && sync.gistId) {
      try {
        await this.gh.gistDelete(sync.gistId);
      } catch (err) {
        log.warn(`Could not delete settings gist ${sync.gistId}: ${(err as Error).message}`);
      }
    }
    this.store.setSettingsSync({ gistId: null, lastSyncedAt: null, lastHash: null });
  }

  async upload(): Promise<void> {
    const sync = this.store.getSettingsSync();
    if (!sync.gistId) throw new Error('Sync is not enabled.');
    const text = await this.currentExportText();
    await this.gh.gistEdit(sync.gistId, GIST_FILENAME, text);
    this.store.setSettingsSync({ ...sync, lastSyncedAt: new Date().toISOString(), lastHash: stableHash(text) });
  }

  async download(mode: 'merge' | 'replace'): Promise<AppSettings> {
    const sync = this.store.getSettingsSync();
    if (!sync.gistId) throw new Error('Sync is not enabled.');
    const text = await this.gh.gistView(sync.gistId, GIST_FILENAME);
    if (text === null) throw new Error('The settings gist no longer exists. Create a new one to sync again.');
    const validated = validateSettingsExport(JSON.parse(text));
    if (!validated.ok) throw new Error(validated.error);
    const settings = this.store.importSettings(validated.data, mode, ['preferences', 'repositories', 'integrations']);
    this.store.setSettingsSync({ ...sync, lastSyncedAt: new Date().toISOString(), lastHash: stableHash(text) });
    return settings;
  }
}
