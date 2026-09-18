import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LfsFile, LfsStatus } from '@shared/types';
import type { ProgressSink } from './operations';
import type { GitClient } from './git';
import { getGitDir } from './status';

/** The fixed first line of every LFS pointer file, tolerating a trailing CRLF. */
const POINTER_HEADER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/;
/** Pointer files are always small, plain-text; anything bigger cannot be one. */
const MAX_POINTER_BYTES = 1024;

export interface LfsPointer {
  oid: string;
  size: number;
}

/** Parses the text of a candidate LFS pointer file; null when it is not one. */
export function parseLfsPointerText(text: string): LfsPointer | null {
  if (!POINTER_HEADER_RE.test(text)) return null;
  const oidMatch = /(?:^|\n)oid sha256:([0-9a-f]{64})\r?(?:\n|$)/.exec(text);
  const sizeMatch = /(?:^|\n)size (\d+)\r?(?:\n|$)/.exec(text);
  if (!oidMatch || !sizeMatch) return null;
  return { oid: oidMatch[1], size: parseInt(sizeMatch[1], 10) };
}

/** Same check against a buffer, used before treating file content as binary. */
export function isLfsPointerBuffer(buf: Buffer | null): LfsPointer | null {
  if (!buf || buf.length > MAX_POINTER_BYTES) return null;
  return parseLfsPointerText(buf.toString('utf8'));
}

/** Local path an LFS object would live at if downloaded, given the repository's `.git` directory. */
export function lfsObjectPath(gitDir: string, oid: string): string {
  return join(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** Reads a local LFS object's content, or null when it has not been downloaded. */
export async function readLfsObject(gitDir: string, oid: string): Promise<Buffer | null> {
  try {
    return await readFile(lfsObjectPath(gitDir, oid));
  } catch {
    return null;
  }
}

/** Extracts glob patterns with a `filter=lfs` attribute from a `.gitattributes` file's content. */
export function parseLfsPatternsFromAttributes(content: string): string[] {
  const patterns: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const spaceIdx = line.search(/\s/);
    if (spaceIdx < 0) continue;
    const pattern = line.slice(0, spaceIdx);
    const attrs = line.slice(spaceIdx + 1);
    if (/(^|\s)filter=lfs(\s|$)/.test(attrs)) patterns.push(pattern);
  }
  return patterns;
}

/**
 * Finds every `filter=lfs` pattern declared anywhere in the repository, by
 * reading every committed `.gitattributes` file plus the worktree's root one
 * (in case LFS tracking was set up but not committed yet). Works even when
 * git-lfs itself is not installed, since it is a plain git/attributes
 * question.
 */
export async function findLfsPatterns(git: GitClient, repoPath: string): Promise<string[]> {
  const patterns = new Set<string>();
  const listed = await git.tryRun(repoPath, ['ls-files', '-z', '--', '*.gitattributes', '.gitattributes'], { readOnly: true });
  const paths = listed ? listed.stdout.split('\0').filter(Boolean) : [];
  for (const p of paths) {
    const content = await git.tryRun(repoPath, ['show', `HEAD:${p}`], { readOnly: true });
    if (!content) continue;
    for (const pat of parseLfsPatternsFromAttributes(content.stdout)) patterns.add(pat);
  }
  try {
    const wt = await readFile(join(repoPath, '.gitattributes'), 'utf8');
    for (const pat of parseLfsPatternsFromAttributes(wt)) patterns.add(pat);
  } catch {
    /* no worktree .gitattributes, or already covered above */
  }
  return [...patterns];
}

/**
 * Resolves which of the given repository-relative paths are attributed
 * `filter=lfs`, using git's own attribute resolution (`check-attr`) so
 * nested `.gitattributes` files and gitignore-style patterns are honoured
 * exactly as git sees them.
 */
export async function lfsTrackedPaths(git: GitClient, repoPath: string, paths: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  if (!paths.length) return result;
  // Paths go over stdin: thousands of changed files would otherwise overflow the Windows command-line limit and the call would silently fail.
  const out = await git.tryRun(repoPath, ['check-attr', 'filter', '-z', '--stdin'], { readOnly: true, stdin: paths.join('\0') + '\0' });
  if (!out) return result;
  const tokens = out.stdout.split('\0');
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    if (tokens[i + 2] === 'lfs') result.add(tokens[i]);
  }
  return result;
}

function parseSizeText(text: string): number | null {
  const m = /^([\d.]+)\s*([KMGT]?B)$/i.exec(text.trim());
  if (!m) return null;
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * (units[m[2].toUpperCase()] ?? 1));
}

/**
 * Parses `git lfs ls-files -l -s` output: `<oid> <marker> <path> (<size>)`,
 * where the marker is `*` when the object is present locally and `-` when
 * it is a pointer only (per git-lfs's `ls-files` documentation).
 */
export function parseLfsLsFiles(output: string): LfsFile[] {
  const files: LfsFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]+)\s+([*-])\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(line);
    if (!m) continue;
    const [, oid, marker, path, sizeText] = m;
    files.push({ oid, present: marker === '*', path, size: sizeText ? parseSizeText(sizeText) : null });
  }
  return files;
}

export type LfsFileChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';

export interface LfsStatusEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
  status: LfsFileChangeKind;
}

/**
 * Parses `git lfs status --porcelain` output. git-lfs prints one entry per
 * line as `<status letter>  <path>[ -> <new path>] <size>` (renames carry the
 * arrow form); the letter is the first character of the change kind and may
 * be upper or lower case depending on the git-lfs version. A plain
 * `git status`-style two-column `XY path` form is accepted too.
 */
export function parseLfsStatusPorcelain(output: string): LfsStatusEntry[] {
  const entries: LfsStatusEntry[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = /^([A-Za-z?\s])([A-Za-z?\s])\s(.*)$/.exec(line);
    if (!m) continue;
    const [, x, rawY, restRaw] = m;
    // Single-letter git-lfs form: letter, two spaces, then the path. Two-column form: XY, space, path.
    const twoColumn = rawY !== ' ' || !restRaw.startsWith(' ');
    const y = twoColumn ? rawY : ' ';
    let rest = twoColumn ? restRaw : restRaw.slice(1);
    rest = rest.trim();
    const sized = /^(.*?)\s+(\d+)$/.exec(rest);
    if (sized) rest = sized[1];
    const arrow = rest.indexOf(' -> ');
    const path = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    const code = (x !== ' ' ? x : y).toUpperCase();
    const status: LfsFileChangeKind = code === 'M' ? 'modified' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' || code === 'C' ? 'renamed' : 'unknown';
    entries.push({ path, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', status });
  }
  return entries;
}

/** True when the repository's local pre-push hook invokes git-lfs. */
export async function lfsHooksInstalled(git: GitClient, repoPath: string): Promise<boolean> {
  try {
    const gitDir = await getGitDir(git, repoPath);
    const content = await readFile(join(gitDir, 'hooks', 'pre-push'), 'utf8');
    return /git[- ]lfs/i.test(content);
  } catch {
    return false;
  }
}

export async function getLfsStatus(git: GitClient, repoPath: string, tool: { installed: boolean; version: string | null }): Promise<LfsStatus> {
  const [patterns, hooksInstalled] = await Promise.all([findLfsPatterns(git, repoPath), lfsHooksInstalled(git, repoPath)]);
  const usedByRepo = patterns.length > 0;
  if (!tool.installed) {
    return { installed: false, version: null, hooksInstalled, usedByRepo, patterns, trackedFiles: 0, localBytes: null, missingFiles: 0 };
  }
  const filesOut = await git.tryRun(repoPath, ['lfs', 'ls-files', '-l', '-s'], { readOnly: true });
  let trackedFiles = 0;
  let localBytes = 0;
  let missingFiles = 0;
  if (filesOut) {
    const files = parseLfsLsFiles(filesOut.stdout);
    trackedFiles = files.length;
    for (const f of files) {
      if (f.present) localBytes += f.size ?? 0;
      else missingFiles++;
    }
  }
  return { installed: true, version: tool.version, hooksInstalled, usedByRepo, patterns, trackedFiles, localBytes: filesOut ? localBytes : null, missingFiles };
}

export async function getLfsFiles(git: GitClient, repoPath: string): Promise<LfsFile[]> {
  const out = await git.tryRun(repoPath, ['lfs', 'ls-files', '-l', '-s'], { readOnly: true });
  return out ? parseLfsLsFiles(out.stdout) : [];
}

export async function lfsInstallLocal(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['lfs', 'install', '--local']);
}

/** Tracks or untracks a glob pattern; git-lfs itself edits `.gitattributes`, preserving its existing line endings. */
export async function setLfsTracking(git: GitClient, repoPath: string, pattern: string, track: boolean): Promise<void> {
  // git-lfs's own CLI (unlike git) does not reliably support "--" as an end-of-options marker.
  await git.run(repoPath, ['lfs', track ? 'track' : 'untrack', pattern]);
  if (existsSync(join(repoPath, '.gitattributes'))) await git.run(repoPath, ['add', '--', '.gitattributes']);
}

/** Parses a `Downloading LFS objects: NN% (a/b), size` progress line into a fraction. */
export function parseLfsProgressLine(chunk: string): { percent: number; description: string } | null {
  let latest: { percent: number; description: string } | null = null;
  for (const line of chunk.split(/[\r\n]+/)) {
    const m = /(\d+)%\s*\((\d+)\/(\d+)\)/.exec(line);
    if (!m) continue;
    latest = { percent: parseInt(m[1], 10) / 100, description: line.trim() };
  }
  return latest;
}

export async function lfsFetch(git: GitClient, repoPath: string, mode: 'fetch-all' | 'pull', paths: string[] | null, onProgress: ProgressSink, signal?: AbortSignal): Promise<void> {
  const args = mode === 'fetch-all' ? ['lfs', 'fetch', '--all'] : ['lfs', 'pull'];
  if (mode === 'pull' && paths && paths.length) args.push('--include', paths.join(','));
  await git.run(repoPath, args, {
    signal,
    onStderr: (chunk) => {
      const p = parseLfsProgressLine(chunk);
      if (p) onProgress(p.percent, p.description);
    },
    timeoutMs: 30 * 60 * 1000,
  });
}

/** Parses `git lfs prune`'s summary line, e.g. "prune: 3 local objects, 1.2 MB". */
export function parseLfsPruneOutput(text: string): { objects: number; bytes: number } {
  // Dry run: "prune: 12 file(s) would be pruned (34.5 MB)".
  const dry = /(\d+)\s+files?(?:\(s\))?\s+would be pruned\s*\(([^)]+)\)/i.exec(text);
  if (dry) return { objects: parseInt(dry[1], 10), bytes: parseSizeText(dry[2]) ?? 0 };
  // Real run: "prune: Deleting objects: 100% (12/12), done." (no size is reported).
  const deleting = /Deleting objects:\s*\d+%\s*\((\d+)\/(\d+)\)/i.exec(text);
  if (deleting) return { objects: parseInt(deleting[2], 10), bytes: 0 };
  // Older / summary form: "N local object(s), … <size>".
  const m = /(\d+)\s+(?:local\s+)?objects?(?:\(s\))?[^\n]*?([\d.]+\s*[KMGT]?i?B)/i.exec(text);
  if (!m) return { objects: 0, bytes: 0 };
  return { objects: parseInt(m[1], 10), bytes: parseSizeText(m[2]) ?? 0 };
}

export async function lfsPrune(git: GitClient, repoPath: string, dryRun: boolean): Promise<{ objects: number; bytes: number }> {
  const args = ['lfs', 'prune'];
  if (dryRun) args.push('--dry-run');
  const out = await git.run(repoPath, args, { timeoutMs: 10 * 60 * 1000 });
  return parseLfsPruneOutput(`${out.stdout}\n${out.stderr}`);
}
