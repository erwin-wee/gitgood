import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OperationOutcome } from '@shared/ipc';
import type { RebaseSquashOptions, Remote, Stash, Tag, GitConfigInfo } from '@shared/types';
import { GitError, TransferProgressParser, type GitClient } from './git';
import { getGitDir } from './status';

export type ProgressSink = (percent: number | null, description: string) => void;

function outcomeFromError(err: unknown): OperationOutcome {
  if (err instanceof GitError && err.info.code === 'conflicts') return { status: 'conflicts' };
  throw err;
}

// ---------- remotes / transfer ----------

export async function getRemotes(git: GitClient, repoPath: string): Promise<Remote[]> {
  const out = await git.stdout(repoPath, ['remote', '-v'], { readOnly: true });
  const map = new Map<string, Remote>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

export async function fetch(git: GitClient, repoPath: string, remote: string | null, onProgress: ProgressSink, signal?: AbortSignal): Promise<void> {
  const parser = new TransferProgressParser('fetch');
  const args = ['fetch', '--progress', '--prune'];
  if (remote) args.push(remote);
  else args.push('--all');
  await git.run(repoPath, args, {
    signal,
    onStderr: (chunk) => {
      const p = parser.feed(chunk);
      if (p) onProgress(p.percent, p.description);
    },
    timeoutMs: 15 * 60 * 1000,
  });
  // Keep origin/HEAD current so the default branch is known; ignore failures.
  await git.tryRun(repoPath, ['remote', 'set-head', remote ?? 'origin', '-a'], { timeoutMs: 30000 });
}

export async function pull(git: GitClient, repoPath: string, rebase: boolean | null, onProgress: ProgressSink, signal?: AbortSignal): Promise<OperationOutcome> {
  const parser = new TransferProgressParser('fetch');
  const args = ['pull', '--progress', '--no-edit'];
  if (rebase === true) args.push('--rebase');
  else if (rebase === false) args.push('--no-rebase');
  try {
    const res = await git.run(repoPath, args, {
      signal,
      env: { GIT_EDITOR: 'true' },
      onStderr: (chunk) => {
        const p = parser.feed(chunk);
        if (p) onProgress(p.percent, p.description);
      },
      timeoutMs: 15 * 60 * 1000,
    });
    if (/Already up to date/i.test(res.stdout)) return { status: 'up-to-date' };
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function push(
  git: GitClient,
  repoPath: string,
  opts: { force: boolean; setUpstream: boolean; remote: string | null; branch: string | null; tags: boolean },
  onProgress: ProgressSink,
  signal?: AbortSignal,
): Promise<void> {
  const parser = new TransferProgressParser('push');
  const args = ['push', '--progress'];
  if (opts.force) args.push('--force-with-lease');
  if (opts.setUpstream) args.push('--set-upstream');
  if (opts.tags) args.push('--follow-tags');
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);
  await git.run(repoPath, args, {
    signal,
    onStderr: (chunk) => {
      const p = parser.feed(chunk);
      if (p) onProgress(p.percent, p.description);
    },
    timeoutMs: 30 * 60 * 1000,
  });
}

export async function clone(git: GitClient, url: string, directory: string, branch: string | null, onProgress: ProgressSink, signal?: AbortSignal): Promise<void> {
  const parser = new TransferProgressParser('fetch');
  const args = ['clone', '--progress', '--recurse-submodules'];
  if (branch) args.push('--branch', branch);
  args.push('--', url, directory);
  await git.run(null, args, {
    signal,
    onStderr: (chunk) => {
      const p = parser.feed(chunk);
      if (p) onProgress(p.percent, p.description);
    },
    timeoutMs: 60 * 60 * 1000,
  });
}

// ---------- merge / rebase / cherry-pick / revert ----------

export async function merge(git: GitClient, repoPath: string, branch: string, squash: boolean): Promise<OperationOutcome> {
  try {
    const args = squash ? ['merge', '--squash', branch] : ['merge', '--no-edit', branch];
    const res = await git.run(repoPath, args, { env: { GIT_EDITOR: 'true' } });
    if (/Already up to date/i.test(res.stdout)) return { status: 'up-to-date' };
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function mergeAbort(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['merge', '--abort']);
}

export async function mergeContinue(git: GitClient, repoPath: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['commit', '--no-edit'], { env: { GIT_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function rebase(git: GitClient, repoPath: string, onto: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['rebase', onto], { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function rebaseContinue(git: GitClient, repoPath: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['rebase', '--continue'], { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function rebaseSkip(git: GitClient, repoPath: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['rebase', '--skip'], { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function rebaseAbort(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['rebase', '--abort']);
}

export async function cherryPick(git: GitClient, repoPath: string, shas: string[]): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['cherry-pick', ...shas], { env: { GIT_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function cherryPickContinue(git: GitClient, repoPath: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['cherry-pick', '--continue'], { env: { GIT_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function cherryPickAbort(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['cherry-pick', '--abort']);
}

export async function revert(git: GitClient, repoPath: string, sha: string): Promise<OperationOutcome> {
  try {
    const isMerge = (await git.stdout(repoPath, ['rev-list', '--parents', '-n', '1', sha], { readOnly: true })).trim().split(' ').length > 2;
    await git.run(repoPath, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), sha], { env: { GIT_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function revertContinue(git: GitClient, repoPath: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['revert', '--continue'], { env: { GIT_EDITOR: 'true' } });
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function revertAbort(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['revert', '--abort']);
}

// ---------- interactive rebase automation (squash / reorder / reword / drop) ----------

interface TodoLine {
  sha: string;
  subject: string;
}

async function listTodo(git: GitClient, repoPath: string, base: string | null): Promise<TodoLine[]> {
  const range = base ? `${base}..HEAD` : 'HEAD';
  const out = await git.stdout(repoPath, ['log', '--reverse', '--format=%H%x1f%P%x1f%s', ...(base ? [range] : [range, '--root'])], { readOnly: true });
  const lines = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, parents, subject] = l.split('\x1f');
      return { sha, parents: (parents ?? '').trim().split(' ').filter(Boolean), subject: subject ?? '' };
    });
  const merge = lines.find((l) => l.parents.length > 1);
  if (merge) {
    throw new GitError({
      message: `The commits being rewritten include the merge commit ${merge.sha.slice(0, 7)} ("${merge.subject}"). Squashing, reordering, rewording or dropping commits across a merge is not supported.`,
      command: 'git rebase -i',
      exitCode: null,
      stderr: '',
      stdout: '',
      code: 'unknown',
    });
  }
  return lines.map(({ sha, subject }) => ({ sha, subject }));
}

/** Determines the rebase base for the given commits: parent of the oldest one, or null for --root. */
async function rebaseBaseFor(git: GitClient, repoPath: string, shas: string[]): Promise<string | null> {
  let oldest: string | null = null;
  for (const sha of shas) {
    if (oldest === null) {
      oldest = sha;
      continue;
    }
    const isAncestor = await git.tryRun(repoPath, ['merge-base', '--is-ancestor', sha, oldest], { readOnly: true });
    if (isAncestor) oldest = sha;
  }
  if (!oldest) throw new Error('No commits given');
  const parents = (await git.stdout(repoPath, ['rev-list', '--parents', '-n', '1', oldest], { readOnly: true })).trim().split(' ');
  return parents.length > 1 ? parents[1] : null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `git rebase -i` with a pre-computed todo list. The sequence editor is
 * this very Electron binary executing a tiny Node script that copies the
 * prepared todo over git's file, which works identically on Windows.
 */
async function runInteractiveRebase(git: GitClient, repoPath: string, base: string | null, todo: string): Promise<OperationOutcome> {
  const gitDir = await getGitDir(git, repoPath);
  const tmpDir = join(gitDir, 'gitgood-rebase');
  await mkdir(tmpDir, { recursive: true });
  const todoFile = join(tmpDir, 'todo.txt');
  const scriptFile = join(tmpDir, 'seq-editor.js');
  await writeFile(todoFile, todo, 'utf8');
  await writeFile(scriptFile, `const fs=require('fs');const [,,src,dst]=process.argv;fs.copyFileSync(src,dst);\n`, 'utf8');
  const exe = process.execPath.replace(/\\/g, '/');
  const editor = `${shQuote(exe)} ${shQuote(scriptFile.replace(/\\/g, '/'))} ${shQuote(todoFile.replace(/\\/g, '/'))}`;
  try {
    await git.run(repoPath, ['rebase', '-i', ...(base ? [base] : ['--root'])], {
      env: { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      timeoutMs: 10 * 60 * 1000,
    });
    return { status: 'complete' };
  } catch (err) {
    if (err instanceof GitError && err.info.code === 'conflicts') return { status: 'conflicts' };
    // Anything else (bad todo, exec failure): restore the branch instead of leaving a half-started rebase.
    await git.tryRun(repoPath, ['rebase', '--abort']);
    throw err;
  } finally {
    rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeMessageFile(git: GitClient, repoPath: string, name: string, message: string): Promise<string> {
  const gitDir = await getGitDir(git, repoPath);
  const dir = join(gitDir, 'gitgood-rebase');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, message.endsWith('\n') ? message : `${message}\n`, 'utf8');
  return file.replace(/\\/g, '/');
}

export async function squashCommits(git: GitClient, repoPath: string, opts: RebaseSquashOptions): Promise<OperationOutcome> {
  const all = [opts.targetSha, ...opts.shas.filter((s) => s !== opts.targetSha)];
  const base = await rebaseBaseFor(git, repoPath, all);
  const todo = await listTodo(git, repoPath, base);
  const toSquash = new Set(opts.shas.filter((s) => s !== opts.targetSha));
  const msgFile = await writeMessageFile(git, repoPath, 'squash-msg.txt', opts.message);
  const lines: string[] = [];
  for (const t of todo) {
    if (toSquash.has(t.sha)) continue;
    lines.push(`pick ${t.sha} ${t.subject}`);
    if (t.sha === opts.targetSha) {
      for (const s of todo) if (toSquash.has(s.sha)) lines.push(`fixup ${s.sha} ${s.subject}`);
      lines.push(`exec git commit --amend --allow-empty -F ${shQuote(msgFile)}`);
    }
  }
  return runInteractiveRebase(git, repoPath, base, lines.join('\n') + '\n');
}

export async function reorderCommits(git: GitClient, repoPath: string, shas: string[], beforeSha: string | null): Promise<OperationOutcome> {
  const involved = beforeSha ? [...shas, beforeSha] : shas;
  let base = await rebaseBaseFor(git, repoPath, involved);
  if (beforeSha === null) {
    // Moving to the top of the branch: base is the parent of the oldest moved commit.
    base = await rebaseBaseFor(git, repoPath, shas);
  }
  const todo = await listTodo(git, repoPath, base);
  const moving = new Set(shas);
  const movedLines = todo.filter((t) => moving.has(t.sha));
  const lines: string[] = [];
  for (const t of todo) {
    if (moving.has(t.sha)) continue;
    if (beforeSha !== null && t.sha === beforeSha) {
      // "before" in display order (newest first) means "after" in todo order (oldest first)
      lines.push(`pick ${t.sha} ${t.subject}`);
      for (const m of movedLines) lines.push(`pick ${m.sha} ${m.subject}`);
      continue;
    }
    lines.push(`pick ${t.sha} ${t.subject}`);
  }
  if (beforeSha === null) for (const m of movedLines) lines.push(`pick ${m.sha} ${m.subject}`);
  return runInteractiveRebase(git, repoPath, base, lines.join('\n') + '\n');
}

export async function rewordCommit(git: GitClient, repoPath: string, sha: string, message: string): Promise<OperationOutcome> {
  const head = (await git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
  if (head === sha) {
    await git.run(repoPath, ['commit', '--amend', '--allow-empty', '-F', '-', '--cleanup=strip'], { stdin: message.endsWith('\n') ? message : `${message}\n` });
    return { status: 'complete' };
  }
  const base = await rebaseBaseFor(git, repoPath, [sha]);
  const todo = await listTodo(git, repoPath, base);
  const msgFile = await writeMessageFile(git, repoPath, 'reword-msg.txt', message);
  const lines = todo.map((t) => `pick ${t.sha} ${t.subject}` + (t.sha === sha ? `\nexec git commit --amend --allow-empty -F ${shQuote(msgFile)}` : ''));
  return runInteractiveRebase(git, repoPath, base, lines.join('\n') + '\n');
}

export async function dropCommit(git: GitClient, repoPath: string, sha: string): Promise<OperationOutcome> {
  const base = await rebaseBaseFor(git, repoPath, [sha]);
  const todo = await listTodo(git, repoPath, base);
  const lines = todo.map((t) => `${t.sha === sha ? 'drop' : 'pick'} ${t.sha} ${t.subject}`);
  return runInteractiveRebase(git, repoPath, base, lines.join('\n') + '\n');
}

// ---------- stash ----------

export const APP_STASH_PREFIX = '!!GitGood';

export async function getStashes(git: GitClient, repoPath: string): Promise<Stash[]> {
  const out = await git.stdout(repoPath, ['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ci'], { readOnly: true });
  const stashes: Stash[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, sha, subject, date] = line.split('\x1f');
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject ?? '');
    const branch = m ? m[1] : null;
    let message = m ? m[2] : subject ?? '';
    const createdByApp = message.startsWith(APP_STASH_PREFIX);
    if (createdByApp) message = message.slice(APP_STASH_PREFIX.length).replace(/^<[^>]*>\s*/, '').trim() || 'Stashed changes';
    const idx = /stash@\{(\d+)\}/.exec(ref ?? '');
    stashes.push({ index: idx ? parseInt(idx[1], 10) : stashes.length, ref: ref ?? `stash@{${stashes.length}}`, sha: sha ?? '', message, branch, date: date ?? '', createdByApp });
  }
  return stashes;
}

export async function stashPush(git: GitClient, repoPath: string, message: string | null, includeUntracked: boolean, paths: string[] | null, branch: string | null): Promise<void> {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  args.push('-m', `${APP_STASH_PREFIX}<${branch ?? ''}> ${message ?? ''}`.trim());
  if (paths && paths.length) args.push('--', ...paths);
  await git.run(repoPath, args);
}

export async function stashPop(git: GitClient, repoPath: string, ref: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['stash', 'pop', ref]);
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function stashApply(git: GitClient, repoPath: string, ref: string): Promise<OperationOutcome> {
  try {
    await git.run(repoPath, ['stash', 'apply', ref]);
    return { status: 'complete' };
  } catch (err) {
    return outcomeFromError(err);
  }
}

export async function stashDrop(git: GitClient, repoPath: string, ref: string): Promise<void> {
  await git.run(repoPath, ['stash', 'drop', ref]);
}

// ---------- tags ----------

export async function getTags(git: GitClient, repoPath: string): Promise<Tag[]> {
  const format = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(contents:subject)', '%(creatordate:iso-strict)'].join('%1f');
  const out = await git.stdout(repoPath, ['for-each-ref', `--format=${format}`, '--sort=-creatordate', 'refs/tags'], { readOnly: true });
  const remoteTags = new Set<string>();
  const remote = await git.tryRun(repoPath, ['ls-remote', '--tags', '--quiet', 'origin'], { readOnly: true, timeoutMs: 15000 });
  if (remote) for (const l of remote.stdout.split('\n')) {
    const m = /refs\/tags\/([^^\s]+)/.exec(l);
    if (m) remoteTags.add(m[1]);
  }
  const tags: Tag[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\x1f');
    const annotated = f[3] === 'tag';
    tags.push({ name: f[0], sha: f[1], targetSha: annotated ? f[2] : f[1], annotated, message: annotated ? f[4] || null : null, date: f[5] || null, unpushed: remote ? !remoteTags.has(f[0]) : false });
  }
  return tags;
}

export async function createTag(git: GitClient, repoPath: string, name: string, sha: string, message: string | null): Promise<void> {
  if (message && message.trim()) await git.run(repoPath, ['tag', '-a', name, sha, '-F', '-'], { stdin: `${message.trim()}\n` });
  else await git.run(repoPath, ['tag', name, sha]);
}

export async function deleteTag(git: GitClient, repoPath: string, name: string, remote: boolean): Promise<void> {
  await git.run(repoPath, ['tag', '-d', name]);
  if (remote) await git.tryRun(repoPath, ['push', 'origin', '--delete', `refs/tags/${name}`]);
}

export async function pushTag(git: GitClient, repoPath: string, name: string): Promise<void> {
  await git.run(repoPath, ['push', 'origin', `refs/tags/${name}`]);
}

// ---------- conflicts ----------

export async function markResolved(git: GitClient, repoPath: string, paths: string[]): Promise<void> {
  await git.run(repoPath, ['add', '--', ...paths]);
}

export async function useSide(git: GitClient, repoPath: string, path: string, side: 'ours' | 'theirs'): Promise<void> {
  const res = await git.tryRun(repoPath, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', path]);
  if (!res) {
    // The chosen side deleted the file.
    await git.run(repoPath, ['rm', '--quiet', '--', path]);
    return;
  }
  await git.run(repoPath, ['add', '--', path]);
}

export async function unresolve(git: GitClient, repoPath: string, path: string, originalContent: string | null): Promise<void> {
  if (originalContent !== null) {
    const { toFsPath } = await import('./diff');
    await writeFile(toFsPath(repoPath, path), originalContent, 'utf8');
  }
  const res = await git.tryRun(repoPath, ['update-index', '--unresolve', '--', path]);
  if (!res && originalContent === null) await git.run(repoPath, ['checkout', '-m', '--', path]);
}

// ---------- config ----------

export async function getConfigIdentity(git: GitClient, repoPath: string | null): Promise<GitConfigInfo> {
  const read = async (scope: string[] , key: string) => (await git.tryRun(repoPath, ['config', ...scope, '--get', key], { readOnly: true }))?.stdout.trim() || null;
  const [gName, gEmail] = await Promise.all([read(['--global'], 'user.name'), read(['--global'], 'user.email')]);
  const [lName, lEmail] = repoPath ? await Promise.all([read(['--local'], 'user.name'), read(['--local'], 'user.email')]) : [null, null];
  const [eName, eEmail] = await Promise.all([read([], 'user.name'), read([], 'user.email')]);
  return { global: { name: gName, email: gEmail }, local: { name: lName, email: lEmail }, effective: { name: eName ?? gName, email: eEmail ?? gEmail } };
}

export async function setConfigIdentity(git: GitClient, repoPath: string | null, scope: 'global' | 'local', name: string, email: string): Promise<void> {
  const flag = scope === 'global' ? '--global' : '--local';
  await git.run(scope === 'global' ? null : repoPath, ['config', flag, 'user.name', name]);
  await git.run(scope === 'global' ? null : repoPath, ['config', flag, 'user.email', email]);
}

export async function unsetLocalIdentity(git: GitClient, repoPath: string): Promise<void> {
  await git.tryRun(repoPath, ['config', '--local', '--unset', 'user.name']);
  await git.tryRun(repoPath, ['config', '--local', '--unset', 'user.email']);
}

export async function getPullRebaseConfig(git: GitClient, repoPath: string): Promise<boolean | null> {
  const out = await git.tryRun(repoPath, ['config', '--get', 'pull.rebase'], { readOnly: true });
  const v = out?.stdout.trim().toLowerCase();
  if (!v) return null;
  return v === 'true' || v === 'merges' || v === 'interactive';
}

// ---------- misc ----------

export async function readGitignore(repoPath: string): Promise<string> {
  try {
    return await readFile(join(repoPath, '.gitignore'), 'utf8');
  } catch {
    return '';
  }
}

export async function writeGitignore(repoPath: string, content: string): Promise<void> {
  await writeFile(join(repoPath, '.gitignore'), content, 'utf8');
}

export async function appendGitignore(repoPath: string, patterns: string[]): Promise<void> {
  const current = await readGitignore(repoPath);
  const existing = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const additions = patterns.filter((p) => !existing.has(p));
  if (!additions.length) return;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  let next = current;
  if (next.length && !next.endsWith('\n')) next += eol;
  next += additions.join(eol) + eol;
  await writeGitignore(repoPath, next);
}

export async function isAncestor(git: GitClient, repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git.tryRun(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant], { readOnly: true })) !== null;
}

export async function getTopLevel(git: GitClient, path: string): Promise<string | null> {
  const out = await git.tryRun(path, ['rev-parse', '--show-toplevel'], { readOnly: true });
  return out?.stdout.trim() || null;
}

export async function init(git: GitClient, directory: string, defaultBranch: string | null): Promise<void> {
  const args = ['init'];
  if (defaultBranch) args.push('-b', defaultBranch);
  await git.run(null, [...args, directory]);
}
