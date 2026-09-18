import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, normalize, parse, sep } from 'node:path';

/**
 * Directory names never descended into. These are the usual large,
 * uninteresting trees; a repository inside one of them is not reported.
 */
export const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out', '.cache']);

export interface ScanOptions {
  /**
   * How many levels below the root may be examined. The root itself is level 0
   * and is always examined, so depth 1 reaches the root's immediate children.
   */
  depth: number;
  signal?: AbortSignal;
  /** Called as each repository is found, so callers can register them while the walk continues. */
  onFound?: (repoPath: string) => void;
  /** Called for each directory examined, for progress reporting. */
  onDirectory?: (dirPath: string) => void;
}

export interface ScanResult {
  repositories: string[];
  /** Directories that could not be read (permissions, or removed mid-walk). */
  unreadable: string[];
  cancelled: boolean;
}

/**
 * Walks `root` looking for Git repositories, reading the filesystem only.
 *
 * A directory is a repository when it directly contains a `.git` entry (a
 * directory for an ordinary clone, a file for a linked worktree or submodule
 * checkout); it is reported and never descended into, so a repository's own
 * submodules and in-tree worktrees do not appear separately. Bare repositories
 * have no `.git` entry and so are never reported.
 *
 * Symbolic links to directories are not followed, which also makes the walk
 * terminate on a self-referential link.
 */
export async function scanFolder(root: string, opts: ScanOptions): Promise<ScanResult> {
  const result: ScanResult = { repositories: [], unreadable: [], cancelled: false };

  const walk = async (dir: string, level: number): Promise<void> => {
    if (opts.signal?.aborted) {
      result.cancelled = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that disappeared between being listed and being walked is
      // not "unreadable": it is gone, and repositories under it should be
      // droppable rather than protected by an unreadable-ancestor entry.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.unreadable.push(dir);
      return;
    }
    opts.onDirectory?.(dir);

    // A .git entry of either kind makes this a repository; stop here.
    if (entries.some((e) => e.name === '.git')) {
      result.repositories.push(dir);
      opts.onFound?.(dir);
      return;
    }

    if (level >= opts.depth) return;

    for (const entry of entries) {
      if (opts.signal?.aborted) {
        result.cancelled = true;
        return;
      }
      // isSymbolicLink() reports the link itself, so this never follows one.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walk(join(dir, entry.name), level + 1);
      if (result.cancelled) return;
    }
  };

  await walk(stripTrailingSeparator(root), 0);
  if (opts.signal?.aborted) result.cancelled = true;
  return result;
}

/** Keeps a trailing separator out of the paths reported for the root itself; case is left alone, unlike paths.ts's comparison form. */
function stripTrailingSeparator(path: string): string {
  let n = normalize(path);
  const root = parse(n).root;
  while (n.length > root.length && n.endsWith(sep)) n = n.slice(0, -1);
  return n;
}
