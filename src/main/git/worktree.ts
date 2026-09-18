import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';
import type { AddWorktreeOptions, Worktree } from '@shared/types';
import type { GitClient } from './git';
import { getGitDir } from './status';

function normalizeForCompare(p: string): string {
  const n = normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** Groups porcelain lines into per-record arrays; an empty token ends a record. */
function splitRecords(raw: string, sep: string): string[][] {
  const tokens = raw.split(sep);
  const records: string[][] = [];
  let current: string[] = [];
  for (const t of tokens) {
    if (t === '') {
      if (current.length) records.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length) records.push(current);
  return records;
}

/**
 * Parses `git worktree list --porcelain` output, in either the `-z`
 * (NUL-terminated) or plain (blank-line separated) format. The separator is
 * auto-detected: `-z` output always contains a NUL byte, which plain
 * porcelain fields never do. Exported standalone (no git invocation) so it
 * can be unit tested directly with both formats.
 */
export function parseWorktreeList(raw: string, currentPath: string | null): Worktree[] {
  const sep = raw.includes('\0') ? '\0' : '\n';
  const records = splitRecords(raw, sep);
  const normalizedCurrent = currentPath ? normalizeForCompare(currentPath) : null;
  const worktrees: Worktree[] = [];
  records.forEach((lines, index) => {
    let path = '';
    let head = '';
    let branch: string | null = null;
    let locked: string | null = null;
    let prunable: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (line === 'locked') locked = '';
      else if (line.startsWith('locked ')) locked = line.slice('locked '.length).trim();
      else if (line === 'prunable') prunable = '';
      else if (line.startsWith('prunable ')) prunable = line.slice('prunable '.length).trim();
      // 'detached' and 'bare' lines carry no data beyond the absence of a 'branch' line.
    }
    if (!path) return;
    worktrees.push({
      path,
      head,
      branch,
      isMain: index === 0,
      isCurrent: normalizedCurrent !== null && normalizeForCompare(path) === normalizedCurrent,
      locked,
      prunable,
      dirty: null,
    });
  });
  return worktrees;
}

/** Lists every worktree of the repository containing `repoPath`, main worktree first. */
export async function listWorktrees(git: GitClient, repoPath: string): Promise<Worktree[]> {
  let raw: string;
  try {
    raw = (await git.run(repoPath, ['worktree', 'list', '--porcelain', '-z'], { readOnly: true, quiet: true })).stdout;
  } catch {
    // Older git (< 2.36) rejects -z; fall back to the plain porcelain format.
    raw = (await git.run(repoPath, ['worktree', 'list', '--porcelain'], { readOnly: true })).stdout;
  }
  return parseWorktreeList(raw, repoPath);
}

export async function addWorktree(git: GitClient, repoPath: string, opts: AddWorktreeOptions): Promise<void> {
  const args = ['worktree', 'add'];
  if (opts.detach) {
    args.push('--detach', opts.path);
    if (opts.startPoint) args.push(opts.startPoint);
  } else if (opts.newBranch) {
    args.push('-b', opts.newBranch, opts.path);
    if (opts.startPoint) args.push(opts.startPoint);
  } else if (opts.branch) {
    args.push(opts.path, opts.branch);
  } else {
    args.push(opts.path);
  }
  await git.run(repoPath, args);
}

export async function removeWorktree(git: GitClient, repoPath: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await git.run(repoPath, args);
}

export async function lockWorktree(git: GitClient, repoPath: string, worktreePath: string, locked: boolean, reason: string | null): Promise<void> {
  if (locked) {
    const args = ['worktree', 'lock'];
    if (reason && reason.trim()) args.push('--reason', reason.trim());
    args.push(worktreePath);
    await git.run(repoPath, args);
  } else {
    await git.run(repoPath, ['worktree', 'unlock', worktreePath]);
  }
}

export async function pruneWorktrees(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['worktree', 'prune', '-v']);
}

/** Absolute path to the `.git` directory shared by every worktree of this repository. */
export async function getCommonDir(git: GitClient, repoPath: string): Promise<string> {
  const out = (await git.stdout(repoPath, ['rev-parse', '--git-common-dir'], { readOnly: true })).trim();
  return isAbsolute(out) ? out : resolve(repoPath, out);
}

/**
 * Resolves the main worktree's root directory for any worktree (main or
 * linked) by comparing `--git-dir` and `--git-common-dir`. Returns null for
 * layouts this can't resolve (e.g. a bare repository), in which case the
 * repository should be treated as its own main worktree.
 */
export async function getMainWorktreePath(git: GitClient, repoPath: string): Promise<string | null> {
  const commonDir = await getCommonDir(git, repoPath);
  if (basename(commonDir) !== '.git') return null;
  return dirname(commonDir);
}

export async function isLinkedWorktree(git: GitClient, repoPath: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([getGitDir(git, repoPath), getCommonDir(git, repoPath)]);
  return normalizeForCompare(gitDir) !== normalizeForCompare(commonDir);
}
