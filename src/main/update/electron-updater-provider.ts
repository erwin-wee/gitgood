/**
 * Real UpdateProvider backed by `electron-updater`'s GitHub provider: checks
 * against the `latest*.yml` files electron-builder's `publish` block emits,
 * downloads in the background with checksum verification, and installs via
 * `quitAndInstall`. The feed itself (owner/repo) comes from `app-update.yml`,
 * generated at build time from `electron-builder.yml`'s `publish` block —
 * never from settings, per the "feed is fixed" decision in design.md.
 *
 * Depends on a narrow structural subset of electron-updater's `AppUpdater`
 * (see `ElectronAutoUpdater` below) rather than the concrete class, so tests
 * can inject a fake instead of the real singleton.
 */
import type { UpdateChannel } from '@shared/types';
import { log } from '../logger';
import type { ReleaseInfo } from './update-core';
import type { UpdateProvider } from './provider';

/** GitHub-provider error codes electron-updater throws when the repository has no matching release yet — equivalent to the fallback's "404 means no releases". */
const NO_RELEASE_CODES = new Set(['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND']);

interface ReleaseNoteInfo {
  readonly version: string;
  readonly note: string | null;
}

interface UpdateInfo {
  readonly version: string;
  readonly releaseDate: string;
  readonly releaseNotes?: string | ReleaseNoteInfo[] | null;
}

interface ProgressInfo {
  readonly percent: number;
  readonly bytesPerSecond: number;
}

/**
 * The slice of electron-updater's `AppUpdater` this provider actually uses,
 * so it can be unit tested against a fake instead of the real singleton.
 * `on`/`once`/`off` are typed loosely (not against `AppUpdaterEvents`)
 * because `AppUpdater`'s real event-emitter type is generic over its keys,
 * which does not structurally satisfy a plain string-keyed interface —
 * the real singleton is passed in via an explicit cast at the call site
 * (src/main/index.ts), verified by hand against electron-updater's .d.ts.
 */
export interface ElectronAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void } | null;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'update-downloaded', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

function releaseUrl(version: string): string {
  return `https://github.com/erwin-wee/gitgood/releases/tag/v${version}`;
}

function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.trim() || null;
  if (Array.isArray(notes)) return notes.map((n) => n.note).filter(Boolean).join('\n\n') || null;
  return null;
}

export class ElectronUpdaterProvider implements UpdateProvider {
  readonly name = 'electron-updater';

  constructor(private readonly updater: ElectronAutoUpdater, private readonly getChannel: () => UpdateChannel) {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.logger = null;
    // electron-updater throws an "error" event (in addition to rejecting the
    // triggering call's promise) on every check/download failure; with no
    // listener that is an uncaught exception that crashes the process.
    this.updater.on('error', (err) => log.warn(`electron-updater: ${err.message}`));
  }

  async fetchLatestRelease(): Promise<ReleaseInfo | null> {
    const channel = this.getChannel();
    this.updater.allowPrerelease = channel === 'beta';
    this.updater.allowDowngrade = false; // isNewerVersion already forbids offering a downgrade; keep electron-updater's own state consistent with that regardless of channel switches.
    this.updater.channel = channel === 'beta' ? 'beta' : null;
    try {
      const result = await this.updater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info) return null;
      return {
        version: info.version,
        releaseDate: info.releaseDate ?? null,
        notes: releaseNotesText(info.releaseNotes),
        url: releaseUrl(info.version),
        prerelease: info.version.includes('-'),
        draft: false,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && NO_RELEASE_CODES.has(code)) return null;
      throw err;
    }
  }

  async startDownload(onProgress: (percent: number | null, bytesPerSecond: number | null) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onDownloadProgress = (p: ProgressInfo) => onProgress(p.percent, p.bytesPerSecond);
      const onDownloaded = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.updater.off('download-progress', onDownloadProgress);
        this.updater.off('update-downloaded', onDownloaded);
        this.updater.off('error', onError);
      };
      this.updater.on('download-progress', onDownloadProgress);
      this.updater.once('update-downloaded', onDownloaded);
      this.updater.once('error', onError);
      this.updater.downloadUpdate().catch(onError);
    });
  }

  async quitAndInstall(isSilent: boolean): Promise<never> {
    this.updater.quitAndInstall(isSilent, true);
    // quitAndInstall() closes every window and quits the app; this promise is never meant to settle.
    return new Promise<never>(() => {});
  }
}
