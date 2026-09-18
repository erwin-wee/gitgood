import type { Commit, CommitFile, CommitSignature, FileStatusKind, HistoryPage, HistoryQuery, ReleaseCommit, SignatureStatus } from '@shared/types';
import { friendlyRegexError, isEmptyHistoryQuery, parseCoAuthors } from '@shared/util';
import type { HistoryOptions } from '@shared/ipc';
import { extractSquashPrNumber, MAX_RANGE_COMMITS } from '../ai/release-notes-core';
import { EMPTY_TREE_SHA, GitError, type GitClient } from './git';
import { lfsTrackedPaths } from './lfs';

/** Matches git's "no commits yet"/"bad revision" fatals (an unborn HEAD, an empty repo, …) so they can be told apart from a regex compile failure, both of which exit 128. */
const EMPTY_HISTORY_STDERR = /bad (default )?revision|unknown revision or path|does not have any commits yet|ambiguous argument 'HEAD'/i;

const FIELD = '\x1f';
const RECORD = '\x1e';
const BASE_FIELDS = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%D', '%s'];
/** `%G?` (validity char), `%GS` (signer name) and `%GK` (key id/fingerprint git used). */
const SIGNATURE_FIELDS = ['%G?', '%GS', '%GK'];
const FORMAT = [...BASE_FIELDS, '%b'].join(`%x1f`) + '%x1e';
const FORMAT_WITH_SIGNATURE = [...BASE_FIELDS, ...SIGNATURE_FIELDS, '%b'].join(`%x1f`) + '%x1e';

/** Maps git's `%G?` single-character validity code to our SignatureStatus. */
export function mapSignatureStatus(gChar: string): SignatureStatus {
  switch (gChar) {
    case 'G':
      return 'good';
    case 'U':
      return 'untrusted';
    case 'X':
      return 'expired';
    case 'Y':
      return 'expired-key';
    case 'R':
      return 'revoked';
    case 'B':
      return 'bad';
    case 'E':
      return 'unknown-key';
    default:
      return 'none';
  }
}

export function parseLog(output: string, withSignature = false): Commit[] {
  const commits: Commit[] = [];
  const minFields = withSignature ? 14 : 11;
  const bodyIndex = withSignature ? 13 : 10;
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const f = trimmed.split(FIELD);
    if (f.length < minFields) continue;
    const parents = f[1].trim() ? f[1].trim().split(' ') : [];
    const body = f.slice(bodyIndex).join(FIELD).replace(/\n+$/, '');
    const refs = f[8]
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => r.replace(/^HEAD -> /, ''));
    let signature: CommitSignature | null = null;
    if (withSignature) {
      const gChar = f[10] ?? '';
      const status = mapSignatureStatus(gChar);
      signature = status === 'none' ? { status: 'none', signer: null, keyId: null } : { status, signer: f[11] || null, keyId: f[12] || null };
    }
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
      signature,
    });
  }
  return commits;
}

/** Turns pathspecs into `-- <pathspec>…` args, adding `:(glob)` magic for anything containing glob characters. */
export function pathspecArgs(paths: string[]): string[] {
  if (!paths.length) return [];
  return ['--', ...paths.map((p) => (/[*?[\]]/.test(p) ? `:(glob)${p}` : p))];
}

/** Builds the git log flags for a `HistoryQuery`'s content/regex/author/date filters. Paths and `allRefs` are handled by the caller (they affect the ref/pathspec positional args, not flags). */
export function historyQueryArgs(query: HistoryQuery | null | undefined): string[] {
  const args: string[] = [];
  if (!query) return args;
  if (query.content) {
    args.push(`-S${query.content}`);
    if (query.contentRegex) args.push('--pickaxe-regex');
  }
  if (query.diffRegex) args.push(`-G${query.diffRegex}`);
  if (query.author) args.push('-i', `--author=${query.author}`);
  if (query.after) args.push(`--after=${query.after}`);
  if (query.before) args.push(`--before=${query.before}`);
  return args;
}

export async function getHistory(git: GitClient, repoPath: string, opts: HistoryOptions, signal?: AbortSignal): Promise<HistoryPage> {
  const limit = Math.max(1, opts.limit);
  const follow = !!opts.follow && !!opts.path;
  const withSignature = !!opts.verifySignatures;
  const format = withSignature ? FORMAT_WITH_SIGNATURE : FORMAT;
  const base = ['log', `--format=${format}`, `--max-count=${limit + 1}`, `--skip=${opts.skip}`, ...(follow ? ['--follow', '-M'] : [])];
  const query = opts.query ?? null;
  const hasQuery = !!query && !isEmptyHistoryQuery(query);
  const refArgs = query?.allRefs ? ['--all'] : [opts.ref ?? 'HEAD'];
  const paths = query?.paths.length ? query.paths : opts.path ? [opts.path] : [];
  const pathArgs = pathspecArgs(paths);
  const search = opts.search?.trim();
  let commits: Commit[] = [];

  if (hasQuery) {
    const args = [...base, ...historyQueryArgs(query)];
    if (search) {
      args.push('-i', `--grep=${search}`);
      // --author and --grep are OR'd by default; --all-match makes every given filter mandatory.
      if (query!.author) args.push('--all-match');
    }
    args.push(...refArgs, ...pathArgs);
    const result = await git.run(repoPath, args, { readOnly: true, okExitCodes: [128], signal });
    if (result.exitCode === 128) {
      if (EMPTY_HISTORY_STDERR.test(result.stderr)) return { commits: [], hasMore: false };
      // A -S/-G/--author/date flag git could not compile or parse (most commonly an invalid `regex:`/`content:` expression) — surface it instead of silently returning no results.
      throw new GitError({ message: friendlyRegexError(result.stderr), command: result.command, exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout, code: 'unknown' });
    }
    commits = parseLog(result.stdout, withSignature);
    const hasMore = commits.length > limit;
    return { commits: commits.slice(0, limit), hasMore };
  }

  if (search) {
    if (/^[0-9a-f]{7,40}$/i.test(search) && opts.skip === 0) {
      const found = await git.tryRun(repoPath, ['log', `--format=${format}`, '--max-count=1', search], { readOnly: true, signal });
      if (found) commits.push(...parseLog(found.stdout, withSignature));
    }
    const byMessage = await git.tryRun(repoPath, [...base, '-i', `--grep=${search}`, ...refArgs, ...pathArgs], { readOnly: true, signal });
    const byAuthor = await git.tryRun(repoPath, [...base, '-i', `--author=${search}`, ...refArgs, ...pathArgs], { readOnly: true, signal });
    const seen = new Set(commits.map((c) => c.sha));
    for (const res of [byMessage, byAuthor]) {
      if (!res) continue;
      for (const c of parseLog(res.stdout, withSignature)) {
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
  const args = [...base, ...refArgs, ...pathArgs];
  const result = await git.run(repoPath, args, { readOnly: true, okExitCodes: [128], signal });
  if (result.exitCode === 128) return { commits: [], hasMore: false };
  commits = parseLog(result.stdout, withSignature);
  const hasMore = commits.length > limit;
  return { commits: commits.slice(0, limit), hasMore };
}

/**
 * Lists the files (relative to the repo root) whose diff at `sha` matches a
 * content/regex query, via `git show --format= --name-only -S<text>|-G<expr>`.
 * Used to narrow the History tab's file list to the files that actually
 * matched a `content:`/`regex:` search. Returns an empty list when the query
 * has neither filter set.
 */
export async function getMatchingFiles(git: GitClient, repoPath: string, sha: string, query: Pick<HistoryQuery, 'content' | 'contentRegex' | 'diffRegex'>): Promise<string[]> {
  if (!query.content && !query.diffRegex) return [];
  const args = ['show', '--format=', '--name-only'];
  if (query.content) {
    args.push(`-S${query.content}`);
    if (query.contentRegex) args.push('--pickaxe-regex');
  }
  if (query.diffRegex) args.push(`-G${query.diffRegex}`);
  args.push(sha);
  const out = await git.tryRun(repoPath, args, { readOnly: true });
  if (!out) return [];
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Maps each commit that touched `path` (following renames) to the name the
 * file had *at that commit*, so the History tab's file-history mode can pick
 * the right entry out of a commit's changed-file list even across renames.
 */
export async function getPathHistory(git: GitClient, repoPath: string, path: string): Promise<{ sha: string; path: string }[]> {
  const out = await git.tryRun(repoPath, ['log', '--follow', '--name-status', '--format=%H', '-M', 'HEAD', '--', path], { readOnly: true });
  if (!out) return [];
  const result: { sha: string; path: string }[] = [];
  let currentSha: string | null = null;
  for (const raw of out.stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[0-9a-f]{40}$/.test(line)) {
      currentSha = line;
      continue;
    }
    if (!currentSha) continue;
    const parts = line.split('\t');
    const letter = parts[0][0];
    const p = letter === 'R' || letter === 'C' ? parts[2] : parts[1];
    if (p !== undefined) result.push({ sha: currentSha, path: p });
  }
  return result;
}

export async function getCommit(git: GitClient, repoPath: string, sha: string, withSignature = false): Promise<Commit> {
  const out = await git.stdout(repoPath, ['log', `--format=${withSignature ? FORMAT_WITH_SIGNATURE : FORMAT}`, '--max-count=1', sha], { readOnly: true });
  const commits = parseLog(out, withSignature);
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
      files.push({ path: newPath, oldPath, status: statusFromLetter(letter), additions: null, deletions: null, binary: false, lfs: false });
    } else {
      const path = tokens[++i];
      if (path === undefined) break;
      files.push({ path, oldPath: null, status: statusFromLetter(letter), additions: null, deletions: null, binary: false, lfs: false });
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
  // A root commit is diffed with `--root` against a single revision, which is diff-tree's
  // "commit diff" mode and (unlike the two-revision form used for every other commit) prints the
  // commit's own SHA as a leading NUL-terminated token; --no-commit-id suppresses it so the -z
  // output always starts with a status/path pair. Harmless (a no-op) in the two-revision form.
  const range = parents.length === 0 ? ['--root', sha] : [parents[0], sha];
  const [nameStatus, numstat] = await Promise.all([
    git.stdout(repoPath, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', ...range], { readOnly: true }),
    git.stdout(repoPath, ['diff-tree', '-r', '-M', '--no-commit-id', '--numstat', '-z', ...range], { readOnly: true }),
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
  if (files.length) {
    // Attributes are resolved against the current worktree/.gitattributes state, not the
    // historical commit's; a reasonable approximation since LFS tracking rarely changes.
    const lfsPaths = await lfsTrackedPaths(git, repoPath, files.map((f) => f.path));
    for (const f of files) if (lfsPaths.has(f.path)) f.lfs = true;
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return files;
}

export async function isCommitPushed(git: GitClient, repoPath: string, sha: string): Promise<boolean | null> {
  const out = await git.tryRun(repoPath, ['branch', '-r', '--contains', sha, '--format=%(refname)'], { readOnly: true });
  if (!out) return null;
  return out.stdout.trim().length > 0;
}

/** Merge base of two refs (`git merge-base`), or null when they share no common history or either ref does not resolve. */
export async function mergeBase(git: GitClient, repoPath: string, a: string, b: string): Promise<string | null> {
  const res = await git.tryRun(repoPath, ['merge-base', a, b], { readOnly: true });
  const sha = res?.stdout.trim();
  return sha || null;
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

export interface CommitPatchResult {
  /** Concatenated per-file patches for the files that fit within `maxBytes`, smallest-first so a handful of huge files never crowd out everything else. */
  patch: string;
  /** Compact `--stat` summary for the whole commit, when it could be computed. */
  stat?: string;
  /** Paths left out because the byte cap was reached (the largest files, in whatever order they were dropped). */
  omitted: string[];
  /** True when at least one file was left out. */
  truncated: boolean;
}

/**
 * Per-file, byte-capped patch text for a commit, used to build AI prompts
 * (see src/main/ai/explain.ts and the rebase-assistant change). Each changed
 * file's diff is fetched independently — merge commits against their first
 * parent (a plain `git show` would otherwise print a combined diff), root
 * commits fall out naturally since `git show` already diffs the first commit
 * against nothing. Files are then included smallest-first until `maxBytes`
 * is reached, so the largest files are the ones left out (`omitted`).
 */
export async function getCommitPatch(git: GitClient, repoPath: string, sha: string, maxBytes: number): Promise<CommitPatchResult> {
  const commit = await getCommit(git, repoPath, sha);
  const files = await getCommitFiles(git, repoPath, sha, commit.parents);
  const isMerge = commit.parents.length > 1;
  const firstParent = parentOrEmptyTree(commit.parents);

  const perFile = await Promise.all(
    files.map(async (file) => {
      if (file.binary) {
        const text = `diff --git a/${file.path} b/${file.path}\nBinary files differ (not shown)\n`;
        return { path: file.path, text, bytes: 0 };
      }
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const args = isMerge ? ['diff', '--no-color', '--no-ext-diff', '-M', firstParent, sha, '--', ...paths] : ['show', '--no-color', '--format=', '-M', sha, '--', ...paths];
      const res = await git.tryRun(repoPath, args, { readOnly: true, okExitCodes: [1], maxBuffer: 64 * 1024 * 1024 });
      const text = res?.stdout ?? '';
      return { path: file.path, text, bytes: Buffer.byteLength(text, 'utf8') };
    }),
  );

  const bySizeAsc = [...perFile].sort((a, b) => a.bytes - b.bytes);
  const included = new Set<string>();
  let budget = maxBytes;
  for (const entry of bySizeAsc) {
    if (entry.bytes <= budget) {
      included.add(entry.path);
      budget -= entry.bytes;
    }
  }
  const omitted = perFile.filter((e) => !included.has(e.path)).map((e) => e.path);
  const patch = perFile
    .filter((e) => included.has(e.path))
    .map((e) => e.text)
    .join('\n');
  const statRes = await git.tryRun(repoPath, ['show', '--stat=120', '--format=', sha], { readOnly: true });
  return { patch, stat: statRes?.stdout, omitted, truncated: omitted.length > 0 };
}

/**
 * Up to `max` recent commits (short SHA + subject) that touched `path`
 * before `sha`, oldest-history-aware: a root commit (no `sha~1`) or any
 * other failure yields an empty list rather than throwing.
 */
export async function getRecentFileHistory(git: GitClient, repoPath: string, sha: string, path: string, max = 5): Promise<string[]> {
  const out = await git.tryRun(repoPath, ['log', `--max-count=${max}`, '--format=%h %s', `${sha}~1`, '--', path], { readOnly: true });
  if (out) return out.stdout.split('\n').filter(Boolean);
  // No parent to start from (root commit): fall back to logging from `sha` itself and drop it,
  // which naturally yields an empty list when there is no earlier history for this path.
  const fallback = await git.tryRun(repoPath, ['log', `--max-count=${max + 1}`, '--format=%h %s', sha, '--', path], { readOnly: true });
  if (!fallback) return [];
  return fallback.stdout.split('\n').filter(Boolean).slice(1);
}

// ---------------------------------------------------------------------------
// Release notes (see src/main/ai/release-notes.ts and release-notes-core.ts)
// ---------------------------------------------------------------------------

const RELEASE_FULL_FIELDS = ['%H', '%h', '%an', '%aI', '%s'];
const RELEASE_FULL_FORMAT = `${RELEASE_FULL_FIELDS.join(FIELD)}${FIELD}%b${RECORD}`;
const RELEASE_SUBJECT_FORMAT = `%H${FIELD}%h${FIELD}%s${RECORD}`;

function rangeArg(from: string | null, to: string): string {
  return from ? `${from}..${to}` : to;
}

function parseReleaseLog(output: string, subjectOnly: boolean): ReleaseCommit[] {
  const commits: ReleaseCommit[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const f = trimmed.split(FIELD);
    if (subjectOnly) {
      if (f.length < 3) continue;
      const subject = f[2].replace(/\n+$/, '');
      commits.push({ sha: f[0], shortSha: f[1], subject, body: '', author: '', date: '', prNumber: extractSquashPrNumber(subject) });
    } else {
      if (f.length < 5) continue;
      const subject = f[4];
      const body = f.slice(5).join(FIELD).replace(/\n+$/, '');
      commits.push({ sha: f[0], shortSha: f[1], author: f[2], date: f[3], subject, body, prNumber: extractSquashPrNumber(subject) });
    }
  }
  return commits;
}

export interface ReleaseLogResult {
  /** Non-merge commits in the range, newest first. Subjects only (empty body/author/date) when `truncated`. */
  commits: ReleaseCommit[];
  /** Subjects of merge commits in the range (for "Merge pull request #N" extraction). */
  mergeSubjects: string[];
  /** True when the range has more than MAX_RANGE_COMMITS non-merge commits; gathering fell back to subjects only. */
  truncated: boolean;
}

/**
 * Non-merge commits and merge-commit subjects for a release-notes range
 * (`from` null means "from the root commit"). Ranges over MAX_RANGE_COMMITS
 * non-merge commits are gathered as subjects only (still enough to extract
 * PR numbers and validate SHA references), per the spec's truncation rule.
 */
export async function getReleaseLog(git: GitClient, repoPath: string, from: string | null, to: string): Promise<ReleaseLogResult> {
  const range = rangeArg(from, to);
  const countOut = await git.tryRun(repoPath, ['rev-list', '--count', '--no-merges', range], { readOnly: true });
  const count = countOut ? parseInt(countOut.stdout.trim(), 10) || 0 : 0;
  const truncated = count > MAX_RANGE_COMMITS;
  const format = truncated ? RELEASE_SUBJECT_FORMAT : RELEASE_FULL_FORMAT;
  const logOut = await git.tryRun(repoPath, ['log', '--no-merges', `--format=${format}`, range], { readOnly: true, maxBuffer: 64 * 1024 * 1024 });
  const commits = logOut ? parseReleaseLog(logOut.stdout, truncated) : [];
  const mergeOut = await git.tryRun(repoPath, ['log', '--merges', '--format=%s', range], { readOnly: true });
  const mergeSubjects = mergeOut ? mergeOut.stdout.split('\n').filter(Boolean) : [];
  return { commits, mergeSubjects, truncated };
}

/** Compact `--stat=120` summary of a release-notes range, capped at 200 lines. */
export async function getReleaseDiffStat(git: GitClient, repoPath: string, from: string | null, to: string): Promise<string> {
  const res = await git.tryRun(repoPath, ['diff', '--stat=120', rangeArg(from, to)], { readOnly: true });
  if (!res) return '';
  return res.stdout.split('\n').slice(0, 200).join('\n');
}
