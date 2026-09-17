import type { Commit, CommitFile, FileStatusKind, HistoryPage } from '@shared/types';
import { parseCoAuthors } from '@shared/util';
import type { HistoryOptions } from '@shared/ipc';
import { EMPTY_TREE_SHA, type GitClient } from './git';

const FIELD = '\x1f';
const RECORD = '\x1e';
const FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%D', '%s', '%b'].join(`%x1f`) + '%x1e';

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const f = trimmed.split(FIELD);
    if (f.length < 11) continue;
    const parents = f[1].trim() ? f[1].trim().split(' ') : [];
    const body = f.slice(10).join(FIELD).replace(/\n+$/, '');
    const refs = f[8]
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => r.replace(/^HEAD -> /, ''));
    commits.push({
      sha: f[0],
      shortSha: f[0].slice(0, 7),
      parents,
      author: { name: f[2], email: f[3], date: f[4] },
      committer: { name: f[5], email: f[6], date: f[7] },
      summary: f[9],
      body,
      refs,
      coAuthors: parseCoAuthors(body),
      isMerge: parents.length > 1,
    });
  }
  return commits;
}

export async function getHistory(git: GitClient, repoPath: string, opts: HistoryOptions): Promise<HistoryPage> {
  const limit = Math.max(1, opts.limit);
  const base = ['log', `--format=${FORMAT}`, `--max-count=${limit + 1}`, `--skip=${opts.skip}`];
  const ref = opts.ref ?? 'HEAD';
  const search = opts.search?.trim();
  let commits: Commit[] = [];
  if (search) {
    if (/^[0-9a-f]{7,40}$/i.test(search) && opts.skip === 0) {
      const found = await git.tryRun(repoPath, ['log', `--format=${FORMAT}`, '--max-count=1', search], { readOnly: true });
      if (found) commits.push(...parseLog(found.stdout));
    }
    const byMessage = await git.tryRun(repoPath, [...base, '-i', `--grep=${search}`, ref, ...(opts.path ? ['--', opts.path] : [])], { readOnly: true });
    const byAuthor = await git.tryRun(repoPath, [...base, '-i', `--author=${search}`, ref, ...(opts.path ? ['--', opts.path] : [])], { readOnly: true });
    const seen = new Set(commits.map((c) => c.sha));
    for (const res of [byMessage, byAuthor]) {
      if (!res) continue;
      for (const c of parseLog(res.stdout)) {
        if (!seen.has(c.sha)) {
          seen.add(c.sha);
          commits.push(c);
        }
      }
    }
    commits.sort((a, b) => new Date(b.committer.date).getTime() - new Date(a.committer.date).getTime());
    const hasMore = commits.length > limit;
    return { commits: commits.slice(0, limit), hasMore };
  }
  const args = [...base, ref];
  if (opts.path) args.push('--', opts.path);
  const result = await git.run(repoPath, args, { readOnly: true, okExitCodes: [128] });
  if (result.exitCode === 128) return { commits: [], hasMore: false };
  commits = parseLog(result.stdout);
  const hasMore = commits.length > limit;
  return { commits: commits.slice(0, limit), hasMore };
}

export async function getCommit(git: GitClient, repoPath: string, sha: string): Promise<Commit> {
  const out = await git.stdout(repoPath, ['log', `--format=${FORMAT}`, '--max-count=1', sha], { readOnly: true });
  const commits = parseLog(out);
  if (!commits.length) throw new Error(`Commit ${sha} not found`);
  return commits[0];
}

function statusFromLetter(letter: string): FileStatusKind {
  switch (letter) {
    case 'A':
      return 'new';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

export function parseNameStatusZ(output: string): CommitFile[] {
  const tokens = output.split('\0');
  const files: CommitFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (newPath === undefined) break;
      files.push({ path: newPath, oldPath, status: statusFromLetter(letter), additions: null, deletions: null, binary: false });
    } else {
      const path = tokens[++i];
      if (path === undefined) break;
      files.push({ path, oldPath: null, status: statusFromLetter(letter), additions: null, deletions: null, binary: false });
    }
  }
  return files;
}

export function parseNumstatZ(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const map = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const binary = m[1] === '-';
    let path = m[3];
    if (path === '') {
      // rename: two following tokens are old and new paths
      i++;
      path = tokens[++i] ?? '';
    }
    map.set(path, { additions: binary ? null : parseInt(m[1], 10), deletions: binary ? null : parseInt(m[2], 10), binary });
  }
  return map;
}

export async function getCommitFiles(git: GitClient, repoPath: string, sha: string, parents: string[]): Promise<CommitFile[]> {
  const range = parents.length === 0 ? ['--root', sha] : [parents[0], sha];
  const [nameStatus, numstat] = await Promise.all([
    git.stdout(repoPath, ['diff-tree', '-r', '-M', '--name-status', '-z', ...range], { readOnly: true }),
    git.stdout(repoPath, ['diff-tree', '-r', '-M', '--numstat', '-z', ...range], { readOnly: true }),
  ]);
  const files = parseNameStatusZ(nameStatus);
  const stats = parseNumstatZ(numstat);
  for (const f of files) {
    const s = stats.get(f.path);
    if (s) {
      f.additions = s.additions;
      f.deletions = s.deletions;
      f.binary = s.binary;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return files;
}

export async function isCommitPushed(git: GitClient, repoPath: string, sha: string): Promise<boolean | null> {
  const out = await git.tryRun(repoPath, ['branch', '-r', '--contains', sha, '--format=%(refname)'], { readOnly: true });
  if (!out) return null;
  return out.stdout.trim().length > 0;
}

export async function compareRefs(git: GitClient, repoPath: string, base: string, head: string): Promise<{ ahead: Commit[]; behind: Commit[] }> {
  const [aheadOut, behindOut] = await Promise.all([
    git.stdout(repoPath, ['log', `--format=${FORMAT}`, '--max-count=200', `${base}..${head}`], { readOnly: true }),
    git.stdout(repoPath, ['log', `--format=${FORMAT}`, '--max-count=200', `${head}..${base}`], { readOnly: true }),
  ]);
  return { ahead: parseLog(aheadOut), behind: parseLog(behindOut) };
}

export function parentOrEmptyTree(parents: string[]): string {
  return parents.length ? parents[0] : EMPTY_TREE_SHA;
}
