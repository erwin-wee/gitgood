import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeStorePlatform, type StorePlatform } from './core/store-platform';
import { DEFAULT_SETTINGS, type AppSettings, type ImportPreview, type InboxItem, type IssueFilter, type RepositoryInfo, type SettingsExport, type SettingsSection } from '@shared/types';
import { log } from './logger';
import { repositoryId } from './repo/manager';
import { normalizePath } from './repo/paths';
import { applyRepositoryImport, buildImportPreview, buildIntegrationsPatch, buildPreferencesPatch, buildSettingsExport, validateSettingsExport } from './settings/sync-core';

/** Retained backups of settings.json, kept before any replace import. */
const MAX_SETTINGS_BACKUPS = 5;

interface Persisted<T> {
  file: string;
  value: T;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const text = readFileSync(file, 'utf8');
    return { ...fallback, ...(JSON.parse(text) as T) };
  } catch (err) {
    log.error(`Failed to read ${file}`, err);
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const dir = join(file, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  sidebarWidth: number;
}

interface AppStateFile {
  window: WindowState;
  currentRepositoryId: string | null;
  recentRepositoryIds: string[];
  zoomLevel: number;
  /** Issues dialog filter choices, remembered per repository (keyed by RepositoryInfo.id). */
  issueFilters: Record<string, IssueFilter>;
  /** Settings sync (secret gist): the gist id is never exported, so it lives here rather than in settings.json. */
  settingsSync: SettingsSyncState;
  /**
   * Version the user dismissed with "Later" on the update banner. Written
   * here for consistency with the rest of persisted app state, but the
   * updater (src/main/update/updater.ts) never reads it back on startup: a
   * dismissal only lasts for the run that recorded it (a fresh launch always
   * re-offers a still-current update), per the auto-update spec.
   */
  dismissedUpdateVersion: string | null;
  /**
   * Per-repository trust for a check command declared in that repository's
   * `.gitgood/config.json`, keyed by the repository's filesystem path.
   * `true` means the user confirmed the verbatim command and it may run;
   * `false` means the user declined and the repository command stays
   * disabled until re-trusted; an absent entry means never asked.
   */
  trustedRepoConfigs: Record<string, boolean>;
  /** The exact check command that was shown when trust was granted, per repository; a changed command re-prompts. */
  trustedRepoCommands: Record<string, string>;
  /**
   * Repositories the user removed from the list while they sat inside a watched
   * folder: a scan must not add them back. Stored normalized (see paths.ts) and
   * machine-local, like the trust maps above — never part of a settings export.
   */
  excludedRepositoryPaths: string[];
}

export interface SettingsSyncState {
  gistId: string | null;
  lastSyncedAt: string | null;
  /** Content hash recorded at the last successful upload or download, used to tell which side changed since (see resolveSyncState). */
  lastHash: string | null;
}

const EMPTY_SETTINGS_SYNC: SettingsSyncState = { gistId: null, lastSyncedAt: null, lastHash: null };

interface SecretsFile {
  anthropicApiKey: string | null;
}

/** Cached notifications inbox: the items shown while offline/before the first poll, and enough of the server's conditional-request state to resume without re-fetching everything. Titles of private repositories live here (see Options → Advanced's "Clear inbox cache"). */
export interface InboxCacheFile {
  items: InboxItem[];
  lastModified: string | null;
  lastPolledAt: string | null;
}

const EMPTY_INBOX_CACHE: InboxCacheFile = { items: [], lastModified: null, lastPolledAt: null };

export class Store {
  private settings!: Persisted<AppSettings>;
  private repos!: Persisted<{ repositories: RepositoryInfo[] }>;
  private state!: Persisted<AppStateFile>;
  private secrets!: Persisted<SecretsFile>;
  private inbox!: Persisted<InboxCacheFile>;
  private listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly dir: string, private readonly platform: StorePlatform = nodeStorePlatform) {}

  load(): void {
    const settingsFile = join(this.dir, 'settings.json');
    const loaded = readJson<AppSettings>(settingsFile, DEFAULT_SETTINGS);
    loaded.ai = { ...DEFAULT_SETTINGS.ai, ...(loaded.ai ?? {}) };
    if (!loaded.defaultCloneDirectory) loaded.defaultCloneDirectory = join(this.platform.documentsDir(), 'GitHub');
    this.settings = { file: settingsFile, value: loaded };
    this.repos = { file: join(this.dir, 'repositories.json'), value: readJson(join(this.dir, 'repositories.json'), { repositories: [] as RepositoryInfo[] }) };
    this.state = {
      file: join(this.dir, 'state.json'),
      value: readJson<AppStateFile>(join(this.dir, 'state.json'), {
        window: { width: 1280, height: 820, maximized: false, sidebarWidth: 300 },
        currentRepositoryId: null,
        recentRepositoryIds: [],
        zoomLevel: 0,
        issueFilters: {},
        settingsSync: EMPTY_SETTINGS_SYNC,
        dismissedUpdateVersion: null,
        trustedRepoConfigs: {},
        trustedRepoCommands: {},
        excludedRepositoryPaths: [],
      }),
    };
    this.secrets = { file: join(this.dir, 'secrets.json'), value: readJson<SecretsFile>(join(this.dir, 'secrets.json'), { anthropicApiKey: null }) };
    this.settings.value.ai.hasApiKey = this.getApiKey() !== null;
    this.inbox = { file: join(this.dir, 'inbox.json'), value: readJson<InboxCacheFile>(join(this.dir, 'inbox.json'), EMPTY_INBOX_CACHE) };
  }

  getSettings(): AppSettings {
    return this.settings.value;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.settings.value, ...patch };
    if (patch.ai) next.ai = { ...this.settings.value.ai, ...patch.ai, hasApiKey: this.getApiKey() !== null };
    this.settings.value = next;
    writeJson(this.settings.file, next);
    for (const l of this.listeners) l(next);
    return next;
  }

  onSettingsChanged(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRepositories(): RepositoryInfo[] {
    return this.repos.value.repositories;
  }

  saveRepositories(repositories: RepositoryInfo[]): void {
    this.repos.value = { repositories };
    writeJson(this.repos.file, this.repos.value);
  }

  getState(): AppStateFile {
    return this.state.value;
  }

  updateState(patch: Partial<AppStateFile>): void {
    this.state.value = { ...this.state.value, ...patch };
    writeJson(this.state.file, this.state.value);
  }

  getIssueFilter(repoId: string): IssueFilter | null {
    return this.state.value.issueFilters[repoId] ?? null;
  }

  setIssueFilter(repoId: string, filter: IssueFilter): void {
    this.updateState({ issueFilters: { ...this.state.value.issueFilters, [repoId]: filter } });
  }

  /**
   * `undefined` means this repository has never been asked about its `.gitgood/config.json` check
   * command. Trust is bound to the command text that was shown: when `command` is given and differs
   * from the one trusted earlier, the answer is `undefined` again so the user is re-prompted with the
   * new command instead of a later commit silently changing what runs.
   */
  getRepoConfigTrust(repoPath: string, command?: string | null): boolean | undefined {
    const trusted = this.state.value.trustedRepoConfigs[repoPath];
    if (trusted !== true || command === undefined || command === null) return trusted;
    const trustedCommand = (this.state.value.trustedRepoCommands ?? {})[repoPath];
    return trustedCommand === undefined || trustedCommand === command ? true : undefined;
  }

  setRepoConfigTrust(repoPath: string, trusted: boolean, command?: string | null): void {
    const commands = { ...(this.state.value.trustedRepoCommands ?? {}) };
    if (trusted && command) commands[repoPath] = command;
    else delete commands[repoPath];
    this.updateState({ trustedRepoConfigs: { ...this.state.value.trustedRepoConfigs, [repoPath]: trusted }, trustedRepoCommands: commands });
  }

  // ---------------- watched-folder exclusions ----------------

  /** Excluded paths as stored (normalized). */
  getExcludedRepositoryPaths(): string[] {
    return this.state.value.excludedRepositoryPaths ?? [];
  }

  isRepositoryExcluded(path: string): boolean {
    const target = normalizePath(path);
    return this.getExcludedRepositoryPaths().some((p) => p === target);
  }

  addExcludedRepositoryPath(path: string): void {
    const target = normalizePath(path);
    if (this.getExcludedRepositoryPaths().includes(target)) return;
    this.updateState({ excludedRepositoryPaths: [...this.getExcludedRepositoryPaths(), target] });
  }

  removeExcludedRepositoryPath(path: string): void {
    const target = normalizePath(path);
    this.updateState({ excludedRepositoryPaths: this.getExcludedRepositoryPaths().filter((p) => p !== target) });
  }

  clearExcludedRepositoryPaths(): void {
    this.updateState({ excludedRepositoryPaths: [] });
  }

  getApiKey(): string | null {
    const stored = this.secrets.value.anthropicApiKey;
    if (!stored) return null;
    try {
      if (stored.startsWith('enc:')) return this.platform.decryptSecret(stored.slice(4));
      return stored;
    } catch (err) {
      log.error('Failed to decrypt stored API key', err);
      return null;
    }
  }

  getInboxCache(): InboxCacheFile {
    return this.inbox.value;
  }

  setInboxCache(value: InboxCacheFile): void {
    this.inbox.value = value;
    writeJson(this.inbox.file, value);
  }

  /** "Clear inbox cache" in Options → Advanced: deletes the cache file (which may hold private-repository titles) and resets in-memory state to empty. */
  clearInboxCache(): void {
    this.inbox.value = EMPTY_INBOX_CACHE;
    try {
      if (existsSync(this.inbox.file)) unlinkSync(this.inbox.file);
    } catch (err) {
      log.error(`Failed to delete ${this.inbox.file}`, err);
    }
  }

  setApiKey(key: string | null): void {
    let stored: string | null = null;
    if (key) {
      const encrypted = this.platform.encryptSecret(key);
      if (encrypted) {
        stored = `enc:${encrypted}`;
      } else {
        log.warn('OS encryption unavailable; storing API key with restricted file permissions only');
        stored = key;
      }
    }
    this.secrets.value = { anthropicApiKey: stored };
    writeJson(this.secrets.file, this.secrets.value);
    this.settings.value = { ...this.settings.value, ai: { ...this.settings.value.ai, hasApiKey: stored !== null } };
    writeJson(this.settings.file, this.settings.value);
    for (const l of this.listeners) l(this.settings.value);
  }

  // ---------------- settings export / import / gist sync ----------------

  getSettingsSync(): SettingsSyncState {
    return this.state.value.settingsSync;
  }

  setSettingsSync(patch: Partial<SettingsSyncState>): SettingsSyncState {
    const next = { ...this.state.value.settingsSync, ...patch };
    this.updateState({ settingsSync: next });
    return next;
  }

  /** Allowlist export builder: only fields covered by PortablePreferences/PortableIntegrations/PortableRepository ever leave this method (see settings/sync-core.ts). */
  buildExport(sections: SettingsSection[], repositories: RepositoryInfo[]): SettingsExport {
    return buildSettingsExport({ sections, settings: this.settings.value, repositories, appVersion: this.platform.appVersion(), platform: process.platform });
  }

  /** Validates a parsed export file and builds an import preview against the current settings/repositories. Throws when the file is not a valid GitGood export. */
  previewImport(raw: unknown, currentRepositories: RepositoryInfo[], mode: 'merge' | 'replace'): ImportPreview {
    const validated = validateSettingsExport(raw);
    if (!validated.ok) throw new Error(validated.error);
    return buildImportPreview({
      file: validated.data,
      currentSettings: this.settings.value,
      currentRepositories,
      pathExists: (p) => existsSync(p),
      filePlatform: validated.data.platform,
      thisPlatform: process.platform,
      validationWarnings: validated.warnings,
      mode,
    });
  }

  /**
   * Applies a validated export to settings and the repository list. Merge
   * only overlays fields present in the file, leaving the rest of each
   * section untouched; Replace resets each selected section's portable
   * fields to defaults first, so fields omitted from the file return to
   * defaults (see buildPreferencesPatch/buildIntegrationsPatch). Sections
   * not requested via `sections` are left alone even when present in the
   * file. A backup of settings.json is written before any Replace.
   */
  importSettings(raw: unknown, mode: 'merge' | 'replace', sections: SettingsSection[]): AppSettings {
    const validated = validateSettingsExport(raw);
    if (!validated.ok) throw new Error(validated.error);
    const file = validated.data;

    if (mode === 'replace') this.writeSettingsBackup();

    let patch: Partial<AppSettings> = {};
    if (sections.includes('preferences') && file.preferences) {
      patch = { ...patch, ...buildPreferencesPatch(this.settings.value, file.preferences, mode) };
    }
    if (sections.includes('integrations') && file.integrations) {
      const { patch: integrationsPatch } = buildIntegrationsPatch(this.settings.value, file.integrations, mode, file.platform, process.platform);
      patch = { ...patch, ...integrationsPatch };
    }
    const settings = Object.keys(patch).length ? this.updateSettings(patch) : this.settings.value;

    if (sections.includes('repositories') && file.repositories) {
      const next = applyRepositoryImport(this.getRepositories(), file.repositories, (p) => repositoryId(p), (p) => existsSync(p));
      this.saveRepositories(next);
    }

    return settings;
  }

  /** Writes a timestamped copy of settings.json before a replace import, keeping only the newest MAX_SETTINGS_BACKUPS. The random suffix keeps filenames unique even when two backups are written within the same millisecond. */
  writeSettingsBackup(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = join(this.dir, `settings.backup-${stamp}-${Math.random().toString(36).slice(2, 8)}.json`);
    try {
      writeJson(backupFile, this.settings.value);
    } catch (err) {
      log.error(`Failed to write settings backup ${backupFile}`, err);
      return;
    }
    try {
      const backups = readdirSync(this.dir)
        .filter((f) => /^settings\.backup-.+\.json$/.test(f))
        .sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - MAX_SETTINGS_BACKUPS))) unlinkSync(join(this.dir, old));
    } catch (err) {
      log.error('Failed to prune old settings backups', err);
    }
  }
}
