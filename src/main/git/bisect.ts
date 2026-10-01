import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNotOption } from '@shared/util';
import type { BisectState } from '@shared/types';
import { GitError, type GitClient } from './git';
import { getGitDir } from './status';

async function isBisecting(git: GitClient, repoPath: string): Promise<boolean> {
  return stat(join(await getGitDir(git, repoPath), 'BISECT_LOG')).then(() => true, () => false);
}

async function describe(git: GitClient, repoPath: string, rev: string): Promise<{ sha: string; summary: string } | null> {
  const out = await git.tryRun(repoPath, ['log', '-1', '--format=%H%x1f%s', rev], { readOnly: true });
  if (!out) return null;
  const [sha, summary = ''] = out.stdout.trim().split('\x1f');
  return { sha, summary };
}

/** While bisecting, HEAD sits at a midpoint; History shows the branch the bisect started from instead so both ends stay visible. Null when not bisecting. */
export async function bisectHistoryRef(git: GitClient, repoPath: string): Promise<string | null> {
  const start = await readFile(join(await getGitDir(git, repoPath), 'BISECT_START'), 'utf8').catch(() => '');
  return start.trim() || null;
}

/**
 * Null when no bisect is running. The counts come from `rev-list --bisect-vars` (what git prints as "N revisions left
 * (roughly M steps)"); ponytail: it ignores `git bisect skip`, so after skips the estimate can be a little high.
 */
export async function getBisectState(git: GitClient, repoPath: string): Promise<BisectState | null> {
  if (!(await isBisecting(git, repoPath))) return null;
  const refs = (await git.tryRun(repoPath, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect'], { readOnly: true }))?.stdout ?? '';
  let bad: string | null = null;
  const good: string[] = [];
  for (const line of refs.split('\n')) {
    const [ref, sha] = line.split(' ');
    if (ref === 'refs/bisect/bad') bad = sha;
    else if (ref?.startsWith('refs/bisect/good-')) good.push(sha);
  }
  const state: BisectState = { bad, good, head: await describe(git, repoPath, 'HEAD'), remaining: null, steps: null, firstBad: null };
  if (bad && good.length) {
    const vars = await git.tryRun(repoPath, ['rev-list', '--bisect-vars', bad, '--not', ...good], { readOnly: true });
    const num = (name: string) => {
      const m = new RegExp(`^${name}=(\\d+)$`, 'm').exec(vars?.stdout ?? '');
      return m ? parseInt(m[1], 10) : null;
    };
    state.remaining = num('bisect_nr');
    state.steps = num('bisect_steps');
    if (num('bisect_all') === 1) state.firstBad = await describe(git, repoPath, bad);
  }
  return state;
}

const refused = (message: string) => new GitError({ message, command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });

/** Starts a bisect between a known bad and a known good commit; git checks out the midpoint. A failed start (e.g. local changes block the checkout) is rolled back. */
export async function bisectStart(git: GitClient, repoPath: string, bad: string, good: string): Promise<void> {
  assertNotOption(bad, good);
  if (await isBisecting(git, repoPath)) throw refused('A bisect is already in progress. Reset it before starting another.');
  // `git bisect start` silently treats an unresolvable argument as a pathspec, so resolve both ends first.
  const [badSha, goodSha] = await Promise.all(
    [bad, good].map(async (rev) => {
      const out = await git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { readOnly: true });
      if (!out) throw refused(`"${rev}" is not a commit in this repository.`);
      return out.stdout.trim();
    }),
  );
  try {
    await git.run(repoPath, ['bisect', 'start', badSha, goodSha, '--']);
  } catch (err) {
    await git.tryRun(repoPath, ['bisect', 'reset']);
    throw err;
  }
}

/** Marks `sha` (default: the commit currently checked out) as good, bad or skipped. */
export async function bisectMark(git: GitClient, repoPath: string, verb: 'good' | 'bad' | 'skip', sha: string | null): Promise<void> {
  if (sha) assertNotOption(sha);
  await git.run(repoPath, ['bisect', verb, ...(sha ? [sha] : [])]);
}

/** Ends the bisect and returns to the branch it started from. */
export async function bisectReset(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['bisect', 'reset']);
}
