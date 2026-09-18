import type { ReleaseInfo } from './update-core';

export type { ReleaseInfo };

/**
 * Seam between the updater's state machine (updater.ts, update-core.ts) and
 * whatever actually talks to GitHub. `ElectronUpdaterProvider` (backed by the
 * `electron-updater` package) implements the full interface, including
 * background download and install; `github-provider.ts`'s dependency-free
 * fallback implements only `fetchLatestRelease`, so it can only ever offer a
 * manual download link — see the `available`-only note on `UpdateState`.
 */
export interface UpdateProvider {
  readonly name: string;
  /** Fetches the latest published release, or null when the repository has none. Throws on network/auth failure. */
  fetchLatestRelease(): Promise<ReleaseInfo | null>;
  /**
   * Downloads the update most recently found by `fetchLatestRelease`,
   * reporting progress until the download completes. Absent means this
   * provider can only offer a manual download link.
   */
  startDownload?(onProgress: (percent: number | null, bytesPerSecond: number | null) => void): Promise<void>;
  /**
   * Installs a downloaded update and restarts the app; never actually
   * resolves on success (the process quits first). Absent means this
   * provider can only offer a manual download.
   */
  quitAndInstall?(isSilent: boolean): Promise<never>;
}
