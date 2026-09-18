import type { ReleaseInfo } from './update-core';

export type { ReleaseInfo };

/**
 * Seam between the updater's state machine (updater.ts, update-core.ts) and
 * whatever actually talks to GitHub. Today the only implementation is the
 * dependency-free github-provider.ts (see the change's design.md: adding
 * `electron-updater` is gated on a new-dependency review that has not
 * happened yet). Swapping to it later means implementing this interface and
 * `quitAndInstall`, without touching the reducer, IPC or renderer.
 */
export interface UpdateProvider {
  readonly name: string;
  /** Fetches the latest published release, or null when the repository has none. Throws on network/auth failure. */
  fetchLatestRelease(): Promise<ReleaseInfo | null>;
  /**
   * Installs a previously downloaded update and restarts the app. Absent
   * (or throwing) means this provider can only offer a manual download —
   * true of every provider until a real downloader lands.
   */
  quitAndInstall?(): Promise<never>;
}
