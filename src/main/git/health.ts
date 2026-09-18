import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Branch, BranchDeleteResult, Housekeeping, LargeBlob, StaleBranch, StaleBranchReason } from '@shared/types';
import type { ToolLocator } from '../tools';
import { deleteLocalBranch, deleteRemoteBranch, getBranches, getDefaultBranch, getMergedBranchNames } from './branches';
import { GitError, type GitClient } from './git';
import { isLfsPointerBuffer, lfsTrackedPaths } from './lfs';
import { getGitDir } from './status';

// ---------------------------------------------------------------------------
// Large files: streamed `rev-list --objects --all | cat-file --batch-check`
// ---------------------------------------------------------------------------

export interface RawBlob {
  sha: string;
  size: number;
  /** Path the blob was found at while walking history (git-lists each reachable blob once, at the path where it was first encountered). */
  path: string;
}

/** Pointer files are always small, plain-text; a blob bigger than this cannot be one. Mirrors lfs.ts's MAX_POINTER_BYTES. */
const MAX_POINTER_CHECK_BYTES = 1024;

/**
 * Parses one line of `git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'`
 * output, fed by piping `git rev-list --objects --all` into it. `%(rest)` is
 * everything after the object name on the input line, i.e. the path
 * `rev-list --objects` printed for that object (verbatim, so it may contain
 * spaces); it is empty for objects `rev-list` printed with no path (most
 * commits, and the root tree). Only blobs with a path are of interest here.
 */
export function parseBatchCheckLine(line: string): RawBlob | null {
  const m = /^(\S+) ([0-9a-f]{4,64}) (\d+)(?: (.*))?$/.exec(line);
  if (!m) return null;
  if (m[1] !== 'blob') return null;
  const path = m[4];
  if (!path) return null;
  return { sha: m[2], size: parseInt(m[3], 10), path };
}

/** Keeps only the `limit` largest blobs seen, in bounded memory, as items are streamed in one at a time. */
export class TopBlobs {
  private items: RawBlob[] = [];
  constructor(private readonly limit: number) {}

  add(item: RawBlob): void {
    if (this.limit <= 0) return;
    if (this.items.length < this.limit) {
      this.items.push(item);
      this.items.sort((a, b) => b.size - a.size);
      return;
    }
    if (item.size <= this.items[this.items.length - 1].size) return;
    this.items[this.items.length - 1] = item;
    this.items.sort((a, b) => b.size - a.size);
  }

  values(): RawBlob[] {
    return [...this.items];
  }
}

/** Convenience wrapper around `TopBlobs` for tests and small in-memory lists. */
export function selectTopBlobs(blobs: RawBlob[], limit: number): RawBlob[] {
  const top = new TopBlobs(limit);
  for (const b of blobs) top.add(b);
  return top.values();
}

/**
 * Streams `git rev-list --objects --all` into `git cat-file --batch-check`
 * via two `child_process.spawn` calls connected by Node streams (no shell,
 * no `maxBuffer`), keeping only the `limit` largest blobs in memory.
 * Cancellable via `signal`.
 */
export function scanLargestBlobs(git: GitClient, tools: ToolLocator, repoPath: string, limit: number, signal?: AbortSignal): Promise<RawBlob[]> {
  return new Promise((resolve, reject) => {
    void (async () => {
      await tools.ensureLocated();
      let gitPath: string;
      try {
        gitPath = tools.gitPath();
      } catch (err) {
        reject(err);
        return;
      }
      const env = await git.baseEnv();
      const top = new TopBlobs(limit);
      const commonArgs = ['-c', 'core.quotePath=false'];
      const revList = spawn(gitPath, [...commonArgs, 'rev-list', '--objects', '--all'], { cwd: repoPath, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const catFile = spawn(gitPath, [...commonArgs, 'cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)'], { cwd: repoPath, env, stdio: ['pipe', 'pipe', 'pipe'] });

      let settled = false;
      let revListErr = '';
      let catFileErr = '';

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        revList.kill();
        catFile.kill();
        fn();
      };

      const onAbort = (): void => finish(() => reject(new GitError({ message: 'Operation cancelled', command: 'git rev-list | git cat-file', exitCode: null, stderr: '', stdout: '', code: 'cancelled' })));

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // If cat-file dies early the pipe gets EPIPE on its stdin; without a listener that would be an uncaught error in the main process.
      catFile.stdin.on('error', () => undefined);
      revList.stdout.pipe(catFile.stdin);
      revList.stderr.on('data', (d: Buffer) => (revListErr += d.toString('utf8')));
      catFile.stderr.on('data', (d: Buffer) => (catFileErr += d.toString('utf8')));
      revList.on('error', (err) => finish(() => reject(err)));
      catFile.on('error', (err) => finish(() => reject(err)));

      revList.on('close', (code) => {
        if (code !== 0 && code !== null) {
          finish(() => reject(new GitError({ message: revListErr.trim() || `git rev-list exited with code ${code}`, command: 'git rev-list --objects --all', exitCode: code, stderr: revListErr, stdout: '', code: 'unknown' })));
        }
      });

      // Decode incrementally so a multi-byte character split across chunks (non-ASCII paths) is not mangled.
      const decoder = new StringDecoder('utf8');
      let buffered = '';
      catFile.stdout.on('data', (chunk: Buffer) => {
        buffered += decoder.write(chunk);
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseBatchCheckLine(line);
          if (parsed) top.add(parsed);
        }
      });

      catFile.on('close', (code) => {
        buffered += decoder.end();
        if (buffered) {
          const parsed = parseBatchCheckLine(buffered);
          if (parsed) top.add(parsed);
        }
        finish(() => {
          if (code !== 0 && code !== null) reject(new GitError({ message: catFileErr.trim() || `git cat-file exited with code ${code}`, command: 'git cat-file --batch-check', exitCode: code, stderr: catFileErr, stdout: '', code: 'unknown' }));
          else resolve(top.values());
        });
      });
    })();
  });
}

/** Blob shas present in HEAD's tree, from `git ls-tree -r HEAD` (default format, not `--name-only`, so the exact blob content at HEAD can be checked, not merely whether the path still exists). */
async function headBlobShas(git: GitClient, repoPath: string): Promise<Set<string>> {
  const shas = new Set<string>();
  const out = await git.tryRun(repoPath, ['ls-tree', '-r', 'HEAD'], { readOnly: true, quiet: true });
  if (!out) return shas;
  for (const line of out.stdout.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(line);
    if (m) shas.add(m[1]);
  }
  return shas;
}

/**
 * Finds the 25 (or `limit`) largest blobs ever committed, with HEAD
 * presence, first-adding commit and whether the path would be tracked by
 * LFS today. Candidates whose content is itself a valid LFS pointer file
 * are dropped (they are not really large; that can only happen in tiny
 * fixtures where nothing else is bigger than a pointer).
 */
export async function findLargestBlobs(git: GitClient, tools: ToolLocator, repoPath: string, limit: number, signal?: AbortSignal): Promise<LargeBlob[]> {
  const raw = await scanLargestBlobs(git, tools, repoPath, limit, signal);
  if (!raw.length) return [];
  const [headShas, lfsPaths] = await Promise.all([headBlobShas(git, repoPath), lfsTrackedPaths(git, repoPath, raw.map((b) => b.path))]);
  const results: LargeBlob[] = [];
  for (const blob of raw) {
    if (blob.size <= MAX_POINTER_CHECK_BYTES) {
      const content = await git.tryRun(repoPath, ['cat-file', '-p', blob.sha], { readOnly: true, quiet: true, maxBuffer: MAX_POINTER_CHECK_BYTES * 4 });
      if (content && isLfsPointerBuffer(content.stdoutBuffer)) continue;
    }
    const firstCommit = await git.tryRun(repoPath, ['log', '--diff-filter=A', '--format=%H%x1f%aI', '-1', '--', blob.path], { readOnly: true, quiet: true });
    const line = firstCommit?.stdout.trim();
    const [firstCommitSha, firstCommitDate] = line ? line.split('\x1f') : [null, null];
    results.push({
      path: blob.path,
      sha: blob.sha,
      size: blob.size,
      firstCommitSha: firstCommitSha || null,
      firstCommitDate: firstCommitDate || null,
      atHead: headShas.has(blob.sha),
      wouldBeLfs: lfsPaths.has(blob.path),
    });
  }
  return results.sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------------------
// Stale branches
// ---------------------------------------------------------------------------

export interface StaleBranchOptions {
  staleBranchDays: number;
  now?: number;
  /** Branch names known to be protected beyond the current and default branches (e.g. from GitHub branch protection, when available). */
  protectedNames?: Set<string>;
}

/** Pure classification: which local branches are merged, inactive and/or upstream-gone. */
export function classifyStaleBranches(branches: Branch[], mergedNames: Set<string>, opts: StaleBranchOptions): StaleBranch[] {
  const now = opts.now ?? Date.now();
  const thresholdMs = opts.staleBranchDays * 24 * 60 * 60 * 1000;
  const results: StaleBranch[] = [];
  for (const b of branches) {
    if (b.kind !== 'local') continue;
    const reasons: StaleBranchReason[] = [];
    if (mergedNames.has(b.name) && !b.isDefault) reasons.push('merged');
    const ageMs = now - Date.parse(b.lastCommitDate);
    if (Number.isFinite(ageMs) && ageMs > thresholdMs) reasons.push('inactive');
    if (b.upstreamGone) reasons.push('gone');
    if (!reasons.length) continue;
    results.push({
      name: b.name,
      reason: reasons,
      sha: b.sha,
      lastCommitDate: b.lastCommitDate,
      upstream: b.upstream,
      isCurrent: b.isCurrent,
      isDefault: b.isDefault,
      protected: b.isCurrent || b.isDefault || (opts.protectedNames?.has(b.name) ?? false),
    });
  }
  return results;
}

export async function getStaleBranches(git: GitClient, repoPath: string, staleBranchDays: number): Promise<StaleBranch[]> {
  const [branches, defaultBranch] = await Promise.all([getBranches(git, repoPath), getDefaultBranch(git, repoPath)]);
  const currentBranch = branches.find((b) => b.isCurrent)?.name ?? null;
  const mergedRef = defaultBranch ?? currentBranch;
  const merged = mergedRef ? await getMergedBranchNames(git, repoPath, mergedRef) : new Set<string>();
  return classifyStaleBranches(branches, merged, { staleBranchDays });
}

/** Deletes several local branches, recording each tip SHA before deletion (so the caller can offer Undo), and optionally the matching remote branch. Failures are reported per branch without stopping the others. */
export async function deleteManyBranches(git: GitClient, repoPath: string, names: string[], deleteRemote: boolean): Promise<BranchDeleteResult> {
  const branches = await getBranches(git, repoPath);
  const deleted: BranchDeleteResult['deleted'] = [];
  const failed: BranchDeleteResult['failed'] = [];
  for (const name of names) {
    const branch = branches.find((b) => b.kind === 'local' && b.name === name);
    if (!branch) {
      failed.push({ name, message: 'Branch no longer exists.' });
      continue;
    }
    try {
      await deleteLocalBranch(git, repoPath, name);
      deleted.push({ name, sha: branch.sha });
    } catch (err) {
      failed.push({ name, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (deleteRemote && branch.upstream) {
      const slash = branch.upstream.indexOf('/');
      if (slash > 0) {
        try {
          await deleteRemoteBranch(git, repoPath, branch.upstream.slice(0, slash), branch.upstream.slice(slash + 1));
        } catch (err) {
          failed.push({ name: branch.upstream, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  return { deleted, failed };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

export interface CountObjectsSummary {
  looseObjectCount: number;
  looseObjectBytes: number;
  packCount: number;
  packBytes: number;
  garbageCount: number;
  garbageBytes: number;
}

/** Parses `git count-objects -v` output; sizes are reported in KiB. */
export function parseCountObjects(output: string): CountObjectsSummary {
  const fields: Record<string, number> = {};
  for (const raw of output.split('\n')) {
    const m = /^([\w-]+):\s*(\d+)/.exec(raw.trim());
    if (m) fields[m[1]] = parseInt(m[2], 10);
  }
  return {
    looseObjectCount: fields.count ?? 0,
    looseObjectBytes: (fields.size ?? 0) * 1024,
    packCount: fields.packs ?? 0,
    packBytes: (fields['size-pack'] ?? 0) * 1024,
    garbageCount: fields.garbage ?? 0,
    garbageBytes: (fields['size-garbage'] ?? 0) * 1024,
  };
}

async function dirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        /* removed mid-walk */
      }
    }
  }
  return total;
}

/** The newest pack file's mtime, used as a proxy for when `git gc` last ran (git does not record this anywhere else). */
async function getLastGcTime(gitDir: string): Promise<number | null> {
  try {
    const packDir = join(gitDir, 'objects', 'pack');
    const files = (await readdir(packDir)).filter((f) => f.endsWith('.pack'));
    if (!files.length) return null;
    let latest = 0;
    for (const f of files) {
      const s = await stat(join(packDir, f));
      if (s.mtimeMs > latest) latest = s.mtimeMs;
    }
    return latest || null;
  } catch {
    return null;
  }
}

export async function getHousekeeping(git: GitClient, repoPath: string): Promise<Housekeeping> {
  const gitDir = await getGitDir(git, repoPath);
  const [countOut, gitDirBytes, lastGcAt] = await Promise.all([git.stdout(repoPath, ['count-objects', '-v'], { readOnly: true }), dirSize(gitDir), getLastGcTime(gitDir)]);
  return { gitDirBytes, lastGcAt, ...parseCountObjects(countOut) };
}

export async function pruneRemote(git: GitClient, repoPath: string, remote: string): Promise<void> {
  await git.run(repoPath, ['remote', 'prune', remote]);
}

export async function runGc(git: GitClient, repoPath: string, aggressive: boolean): Promise<void> {
  const args = ['gc'];
  if (aggressive) args.push('--aggressive');
  await git.run(repoPath, args, { timeoutMs: 20 * 60 * 1000 });
}

export async function expireReflog(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['reflog', 'expire', '--expire=now', '--all']);
}
