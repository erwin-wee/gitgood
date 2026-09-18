import { realpath } from 'node:fs/promises';
import { normalize, parse, sep } from 'node:path';

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
