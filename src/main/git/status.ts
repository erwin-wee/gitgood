import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { BranchState, ConflictKind, FileStatusKind, InProgressOperation, RepositoryStatus, WorkingFile } from '@shared/types';
import type { GitClient } from './git';
import { lfsTrackedPaths } from './lfs';

const gitDirCache = new Map<string, string>();

export async function getGitDir(git: GitClient, repoPath: string): Promise<string> {
  const cached = gitDirCache.get(repoPath);
  if (cached) return cached;
  const out = (await git.stdout(repoPath, ['rev-parse', '--git-dir'], { readOnly: true })).trim();
  const dir = isAbsolute(out) ? out : resolve(repoPath, out);
  gitDirCache.set(repoPath, dir);
  return dir;
}

async function readText(file: string): Promise<string | null> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function conflictKind(xy: string): ConflictKind {
  switch (xy) {
    case 'DD':
      return 'both-deleted';
    case 'AU':
      return 'added-by-us';
    case 'UD':
      return 'deleted-by-them';
    case 'UA':
      return 'added-by-them';
    case 'DU':
      return 'deleted-by-us';
    case 'AA':
      return 'both-added';
    default:
      return 'both-modified';
  }
}

function statusFromXY(x: string, y: string): FileStatusKind {
  if (x === 'A' || (x === '.' && y === 'A')) return 'new';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'T' || y === 'T') return 'typechange';
  return 'modified';
}

export function parsePorcelainV2(output: string): { branch: BranchState; files: WorkingFile[] } {
  const tokens = output.split('\0');
  const files: WorkingFile[] = [];
  const branch: BranchState = { name: null, sha: null, upstream: null, ahead: 0, behind: 0, detached: false, unborn: false, upstreamGone: false };
  let hasAb = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        if (value === '(initial)') branch.unborn = true;
        else branch.sha = value;
      } else if (key === 'branch.head') {
        if (value === '(detached)') branch.detached = true;
        else branch.name = value;
      } else if (key === 'branch.upstream') {
        branch.upstream = value;
      } else if (key === 'branch.ab') {
        hasAb = true;
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) {
          branch.ahead = parseInt(m[1], 10);
          branch.behind = parseInt(m[2], 10);
        }
      }
      continue;
    }
    const kind = t[0];
    if (kind === '1') {
      const parts = t.split(' ');
      const xy = parts[1];
      const sub = parts[2];
      const path = parts.slice(8).join(' ');
      files.push({
        path,
        oldPath: null,
        status: statusFromXY(xy[0], xy[1]),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        submodule: sub.startsWith('S'),
        conflict: null,
        lfs: false,
      });
    } else if (kind === '2') {
      const parts = t.split(' ');
      const xy = parts[1];
      const sub = parts[2];
      const path = parts.slice(9).join(' ');
      const origPath = tokens[++i] ?? null;
      files.push({
        path,
        oldPath: origPath,
        status: xy[0] === 'C' || xy[1] === 'C' ? 'copied' : 'renamed',
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        submodule: sub.startsWith('S'),
        conflict: null,
        lfs: false,
      });
    } else if (kind === 'u') {
      const parts = t.split(' ');
      const xy = parts[1];
      const sub = parts[2];
      const path = parts.slice(10).join(' ');
      files.push({ path, oldPath: null, status: 'conflicted', staged: false, unstaged: true, submodule: sub.startsWith('S'), conflict: conflictKind(xy), lfs: false });
    } else if (kind === '?') {
      files.push({ path: t.slice(2), oldPath: null, status: 'untracked', staged: false, unstaged: true, submodule: false, conflict: null, lfs: false });
    } else if (kind === '!') {
      files.push({ path: t.slice(2), oldPath: null, status: 'ignored', staged: false, unstaged: false, submodule: false, conflict: null, lfs: false });
    }
  }
  if (branch.upstream && !hasAb) branch.upstreamGone = true;
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return { branch, files };
}

async function resolveName(git: GitClient, repoPath: string, sha: string): Promise<string | null> {
  const out = await git.tryRun(repoPath, ['name-rev', '--name-only', '--no-undefined', '--refs=refs/heads/*', '--refs=refs/remotes/*', sha], { readOnly: true });
  if (!out) return null;
  const name = out.stdout.trim().replace(/^remotes\//, '');
  if (!name || /[~^]/.test(name) || name === 'undefined') return null;
  return name;
}

export async function detectOperation(git: GitClient, repoPath: string, gitDir: string): Promise<InProgressOperation> {
  const op: InProgressOperation = { kind: 'none', headName: null, onto: null, ontoName: null, current: null, total: null, targetSha: null, targetName: null, message: null };
  if (await exists(join(gitDir, 'rebase-merge'))) {
    op.kind = 'rebase';
    op.headName = (await readText(join(gitDir, 'rebase-merge', 'head-name')))?.replace(/^refs\/heads\//, '') ?? null;
    op.onto = await readText(join(gitDir, 'rebase-merge', 'onto'));
    const cur = await readText(join(gitDir, 'rebase-merge', 'msgnum'));
    const end = await readText(join(gitDir, 'rebase-merge', 'end'));
    op.current = cur ? parseInt(cur, 10) : null;
    op.total = end ? parseInt(end, 10) : null;
    op.message = await readText(join(gitDir, 'rebase-merge', 'message'));
  } else if (await exists(join(gitDir, 'rebase-apply'))) {
    op.kind = 'rebase';
    op.headName = (await readText(join(gitDir, 'rebase-apply', 'head-name')))?.replace(/^refs\/heads\//, '') ?? null;
    op.onto = await readText(join(gitDir, 'rebase-apply', 'onto'));
    const cur = await readText(join(gitDir, 'rebase-apply', 'next'));
    const end = await readText(join(gitDir, 'rebase-apply', 'last'));
    op.current = cur ? parseInt(cur, 10) : null;
    op.total = end ? parseInt(end, 10) : null;
  } else if (await exists(join(gitDir, 'MERGE_HEAD'))) {
    op.kind = 'merge';
    op.targetSha = (await readText(join(gitDir, 'MERGE_HEAD')))?.split('\n')[0] ?? null;
    op.message = await readText(join(gitDir, 'MERGE_MSG'));
  } else if (await exists(join(gitDir, 'CHERRY_PICK_HEAD'))) {
    op.kind = 'cherry-pick';
    op.targetSha = await readText(join(gitDir, 'CHERRY_PICK_HEAD'));
    const todo = await readText(join(gitDir, 'sequencer', 'todo'));
    if (todo) {
      const remaining = todo.split('\n').filter((l) => /^(pick|p) /.test(l)).length;
      op.total = remaining + 1;
      op.current = 1;
    }
  } else if (await exists(join(gitDir, 'REVERT_HEAD'))) {
    op.kind = 'revert';
    op.targetSha = await readText(join(gitDir, 'REVERT_HEAD'));
  } else if (await exists(join(gitDir, 'BISECT_LOG'))) {
    op.kind = 'bisect';
  }
  if (op.onto) op.ontoName = await resolveName(git, repoPath, op.onto);
  if (op.targetSha) {
    op.targetName = await resolveName(git, repoPath, op.targetSha);
    if (op.kind === 'merge' && op.message) {
      const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(op.message);
      if (m) op.targetName = m[1];
    }
  }
  return op;
}

export async function getStatus(git: GitClient, repoPath: string): Promise<RepositoryStatus> {
  const gitDir = await getGitDir(git, repoPath);
  const result = await git.run(repoPath, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignore-submodules=none', '-z'], { readOnly: true, maxBuffer: 256 * 1024 * 1024 });
  const { branch, files } = parsePorcelainV2(result.stdout);
  const nonSubmodulePaths = files.filter((f) => !f.submodule).map((f) => f.path);
  if (nonSubmodulePaths.length) {
    const lfsPaths = await lfsTrackedPaths(git, repoPath, nonSubmodulePaths);
    for (const f of files) if (lfsPaths.has(f.path)) f.lfs = true;
  }
  const operation = await detectOperation(git, repoPath, gitDir);
  if (branch.detached && operation.kind === 'rebase' && operation.headName) {
    // While rebasing git reports a detached HEAD; show the branch being rebased.
    branch.name = operation.headName;
  }
  let lastFetched: number | null = null;
  try {
    lastFetched = (await stat(join(gitDir, 'FETCH_HEAD'))).mtimeMs;
  } catch {
    /* never fetched */
  }
  return { branch, files: files.filter((f) => f.status !== 'ignored'), operation, hasConflicts: files.some((f) => f.conflict !== null), lastFetched };
}
