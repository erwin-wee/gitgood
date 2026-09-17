import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { DEFAULT_SETTINGS, type AppSettings, type RepositoryInfo } from '@shared/types';
import { log } from './logger';

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
}

interface SecretsFile {
  anthropicApiKey: string | null;
}

export class Store {
  private settings!: Persisted<AppSettings>;
  private repos!: Persisted<{ repositories: RepositoryInfo[] }>;
  private state!: Persisted<AppStateFile>;
  private secrets!: Persisted<SecretsFile>;
  private listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly dir: string) {}

  load(): void {
    const settingsFile = join(this.dir, 'settings.json');
    const loaded = readJson<AppSettings>(settingsFile, DEFAULT_SETTINGS);
    loaded.ai = { ...DEFAULT_SETTINGS.ai, ...(loaded.ai ?? {}) };
    if (!loaded.defaultCloneDirectory) loaded.defaultCloneDirectory = join(app.getPath('documents'), 'GitHub');
    this.settings = { file: settingsFile, value: loaded };
    this.repos = { file: join(this.dir, 'repositories.json'), value: readJson(join(this.dir, 'repositories.json'), { repositories: [] as RepositoryInfo[] }) };
    this.state = {
      file: join(this.dir, 'state.json'),
      value: readJson<AppStateFile>(join(this.dir, 'state.json'), {
        window: { width: 1280, height: 820, maximized: false, sidebarWidth: 300 },
        currentRepositoryId: null,
        recentRepositoryIds: [],
        zoomLevel: 0,
      }),
    };
    this.secrets = { file: join(this.dir, 'secrets.json'), value: readJson<SecretsFile>(join(this.dir, 'secrets.json'), { anthropicApiKey: null }) };
    this.settings.value.ai.hasApiKey = this.getApiKey() !== null;
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

  getApiKey(): string | null {
    const stored = this.secrets.value.anthropicApiKey;
    if (!stored) return null;
    try {
      if (stored.startsWith('enc:')) {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      }
      return stored;
    } catch (err) {
      log.error('Failed to decrypt stored API key', err);
      return null;
    }
  }

  setApiKey(key: string | null): void {
    let stored: string | null = null;
    if (key) {
      if (safeStorage.isEncryptionAvailable()) {
        stored = `enc:${safeStorage.encryptString(key).toString('base64')}`;
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
}
