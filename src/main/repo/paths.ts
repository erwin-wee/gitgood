import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, normalize, parse, sep } from 'node:path';

/**
 * Path comparison for watched folders and exclusions, matching the rules
 * `repositoryId()` uses: `normalize()` everywhere, plus case folding on Windows.
 * A trailing separator is stripped (except on a filesystem root), so
 * `C:\Users\me\Projects\` and `C:\Users\me\Projects` are the same folder.
 */
export function normalizePath(path: string): string {
  const n = stripTrailingSeparator(path);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * The physical path, with symbolic links (and Windows junctions) resolved, or
 * the path itself when it cannot be resolved.
 *
 * Watched folders are stored in this form because git reports physical paths:
 * `git rev-parse --show-toplevel` under `~/Projects` → `/mnt/data/Projects`
 * returns the `/mnt/data` path, so a folder kept as the link path would never
 * match the repositories found inside it.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return stripTrailingSeparator(await realpath(path));
  } catch {
    return stripTrailingSeparator(path);
  }
}

function stripTrailingSeparator(path: string): string {
  let n = normalize(path);
  const root = parse(n).root;
  while (n.length > root.length && n.endsWith(sep)) n = n.slice(0, -1);
  return n;
}

/**
 * True when `child` is `parent` itself or sits beneath it. Comparing with the
 * separator appended keeps `/a/bc` from counting as inside `/a/b`.
 */
export function isInside(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Reads a regular file inside the repository, or returns null. Repo contents are
 * untrusted: a symlink (or a symlinked parent directory) must never make us read
 * — and later upload to an AI backend or run — a file outside the repo. Symlinks
 * are refused outright and the resolved path must stay inside the resolved repo.
 * ponytail: lstat/realpath then read is not atomic; a racing local writer could swap in a link.
 */
export async function readRepoFile(repoPath: string, relPath: string): Promise<Buffer | null> {
  try {
    const file = join(repoPath, ...relPath.split('/'));
    if (!(await lstat(file)).isFile()) return null;
    if (!isInside(await realpath(repoPath), await realpath(file))) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Throws unless the deepest existing ancestor of `fsPath` resolves (symlinks included) to a place inside the repository. For writes that may create new directories. */
export async function assertInsideRepo(repoPath: string, fsPath: string): Promise<void> {
  const root = await realpath(repoPath);
  let dir = dirname(fsPath);
  for (;;) {
    try {
      if (isInside(root, await realpath(dir))) return;
      throw new Error(`Path escapes the repository: ${fsPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      dir = dirname(dir);
    }
  }
}
