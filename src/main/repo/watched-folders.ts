import { stat } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import {
  WATCHED_FOLDER_DEFAULT_DEPTH,
  WATCHED_FOLDER_MAX_DEPTH,
  WATCHED_FOLDER_MIN_DEPTH,
  type RepositoryScanResult,
  type WatchedFolder,
  type WatchedFolderProblem,
  type WatchedFolderStatus,
} from '@shared/types';
import { log } from '../logger';
import type { Store } from '../store';
import type { EventSender, RepositoryManager } from './manager';
import { canonicalPath, isInside, samePath } from './paths';
import { scanFolder } from './scan';

/** Repositories handed to `addMany` at a time, so the list fills in while the walk continues. */
const ADD_BATCH_SIZE = 10;
/** Minimum ms between progress events, so a big tree does not flood the renderer. */
const PROGRESS_THROTTLE_MS = 150;

// ---------------------------------------------------------------------------
// Registration validation (pure)
// ---------------------------------------------------------------------------

export function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return WATCHED_FOLDER_DEFAULT_DEPTH;
  return Math.min(WATCHED_FOLDER_MAX_DEPTH, Math.max(WATCHED_FOLDER_MIN_DEPTH, Math.round(depth)));
}

export type AddFolderResult = { ok: true; folders: WatchedFolder[] } | { ok: false; error: string };

/**
 * Adds `path` to `existing`, rejecting a folder that is already watched or that
 * sits inside one that is — a nested folder would be walked twice and its
 * repositories attributed to whichever scan reached them first.
 */
export function addWatchedFolder(existing: WatchedFolder[], path: string, depth = WATCHED_FOLDER_DEFAULT_DEPTH): AddFolderResult {
  const candidate = resolve(normalize(path.trim()));
  if (!candidate) return { ok: false, error: 'Choose a folder to watch.' };

  const duplicate = existing.find((f) => samePath(f.path, candidate));
  if (duplicate) return { ok: false, error: `"${duplicate.path}" is already a watched folder.` };

  const covering = existing.find((f) => isInside(f.path, candidate));
  if (covering) return { ok: false, error: `"${covering.path}" is already watched and covers this folder.` };

  const covered = existing.filter((f) => isInside(candidate, f.path));
  if (covered.length) {
    return { ok: false, error: `Remove ${covered.map((f) => `"${f.path}"`).join(' and ')} first — this folder contains ${covered.length === 1 ? 'it' : 'them'}.` };
  }

  return { ok: true, folders: [...existing, { path: candidate, depth: clampDepth(depth) }] };
}

/** Normalizes a whole list arriving from a settings patch: clamped depths, no duplicates, no folder nested in another. */
export function sanitizeWatchedFolders(folders: WatchedFolder[]): WatchedFolder[] {
  const out: WatchedFolder[] = [];
  for (const folder of folders) {
    if (!folder || typeof folder.path !== 'string' || !folder.path.trim()) continue;
    const result = addWatchedFolder(out, folder.path, folder.depth);
    if (result.ok) out.push(result.folders[result.folders.length - 1]);
  }
  return out;
}

/** Whether the two lists differ in the ways that call for a rescan (membership or depth). */
export function watchedFoldersDiffer(a: WatchedFolder[], b: WatchedFolder[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((folder, i) => !samePath(folder.path, b[i].path) || folder.depth !== b[i].depth);
}

/** Why a watched folder cannot be walked, or null when it is a readable directory. */
export async function folderProblem(path: string): Promise<WatchedFolderProblem | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? null : 'not-a-directory';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'ENOTDIR') return 'not-a-directory';
    // EACCES/EPERM, plus ELOOP, ENAMETOOLONG and anything else: the folder is
    // there as far as we know, we just cannot look inside it.
    return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const EMPTY_RESULT: RepositoryScanResult = { added: 0, skipped: 0, failed: 0, unreadable: 0, dropped: 0, cancelled: false, folders: [] };

/**
 * Runs watched-folder scans: one at a time, cancellable, reporting progress.
 *
 * Scans are started by the launch hook, by a change to the watched-folder
 * settings, and by the user. There is deliberately no filesystem watch between
 * them — see the change's design notes.
 */
export class WatchedFolderScanner {
  private controller: AbortController | null = null;
  private inFlight: Promise<RepositoryScanResult> | null = null;

  constructor(
    private readonly store: Store,
    private readonly repos: RepositoryManager,
    private readonly send: EventSender,
  ) {}

  isScanning(): boolean {
    return this.inFlight !== null;
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Starts a scan, or reports `alreadyRunning` and leaves the one in flight alone. */
  async scan(): Promise<RepositoryScanResult> {
    if (this.inFlight) return { ...EMPTY_RESULT, alreadyRunning: true };
    const folders = this.store.getSettings().watchedFolders;
    if (!folders.length) return { ...EMPTY_RESULT };

    this.controller = new AbortController();
    this.inFlight = this.run(folders, this.controller.signal);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
      this.controller = null;
    }
  }

  private async run(folders: WatchedFolder[], signal: AbortSignal): Promise<RepositoryScanResult> {
    const result: RepositoryScanResult = { added: 0, skipped: 0, failed: 0, unreadable: 0, dropped: 0, cancelled: false, folders: [] };
    let scanned = 0;
    let found = 0;
    let lastProgressAt = 0;

    for (const folder of folders) {
      if (signal.aborted) {
        result.cancelled = true;
        break;
      }

      const problem = await folderProblem(folder.path);
      const status: WatchedFolderStatus = { path: folder.path, problem };
      result.folders.push(status);
      if (problem) {
        if (problem === 'unreadable') result.unreadable++;
        continue;
      }
      // Walk and compare on the physical path: git reports repositories by
      // their resolved location, so a folder reached through a symlink must be
      // resolved here or nothing inside it would ever match. Depth is clamped
      // in case settings.json was hand-edited past the range the UI enforces.
      const root = await canonicalPath(folder.path);
      const depth = clampDepth(folder.depth);

      const pending: string[] = [];
      // onFound is synchronous, so registrations are chained onto this instead
      // of awaited inline: the list fills in while the walk carries on.
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (batch: string[]): void => {
        if (!batch.length) return;
        queue = queue.then(() => this.registerBatch(batch, folder.path, result));
      };

      const walk = await scanFolder(root, {
        depth,
        signal,
        onDirectory: () => {
          scanned++;
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
            lastProgressAt = now;
            this.send('repos.scanProgress', { folder: folder.path, scanned, found });
          }
        },
        onFound: (repoPath) => {
          found++;
          pending.push(repoPath);
          if (pending.length >= ADD_BATCH_SIZE) enqueue(pending.splice(0, ADD_BATCH_SIZE));
        },
      });

      enqueue(pending.splice(0, pending.length));
      await queue;

      result.unreadable += walk.unreadable.length;
      if (walk.cancelled) {
        result.cancelled = true;
        break;
      }

      // Only a scan that completed and could read the whole subtree may drop.
      try {
        const dropped = await this.repos.dropVanished(root, walk.unreadable);
        result.dropped += dropped.length;
      } catch (err) {
        log.error(`Failed to drop vanished repositories under ${root}`, err);
      }
    }

    this.send('repos.scanProgress', { folder: '', scanned, found });
    return result;
  }

  private async registerBatch(batch: string[], folderPath: string, result: RepositoryScanResult): Promise<void> {
    if (!batch.length) return;
    try {
      const { added, skipped, failed } = await this.repos.addMany(batch);
      result.added += added.length;
      result.skipped += skipped;
      result.failed += failed;
    } catch (err) {
      log.error(`Failed to register repositories from ${folderPath}`, err);
    }
  }

  /**
   * Rescans when the watched-folder settings change. Every other settings edit
   * is ignored, so changing the theme does not start a filesystem walk.
   */
  watchSettings(): () => void {
    let previous = this.store.getSettings().watchedFolders;
    return this.store.onSettingsChanged((settings) => {
      const next = settings.watchedFolders;
      if (!watchedFoldersDiffer(previous, next)) return;
      previous = next;
      if (!next.length) return;
      void this.scan().catch((err) => log.error('Watched-folder scan failed', err));
    });
  }
}
