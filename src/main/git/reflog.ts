import { assertNotOption } from '@shared/util';
import type { ReflogEntry, UndoPlan } from '@shared/types';
import { GitError, type GitClient } from './git';
import * as ops from './operations';

const FIELD = '\x1f';

/** Parses `git reflog --format=%H<US>%gs<US>%ct` output (newest first). */
export function parseReflog(output: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [sha, subject = '', ct = '0'] = line.split(FIELD);
    const colon = subject.indexOf(': ');
    entries.push({
      index: entries.length,
      sha,
      action: colon < 0 ? subject : subject.slice(0, colon),
      message: colon < 0 ? '' : subject.slice(colon + 2),
      timestamp: parseInt(ct, 10) * 1000,
    });
  }
  return entries;
}

export async function getReflog(git: GitClient, repoPath: string, limit = 300): Promise<ReflogEntry[]> {
  // An unborn branch has no HEAD reflog yet; git exits non-zero there.
  const out = await git.tryRun(repoPath, ['reflog', 'show', 'HEAD', `--format=%H${FIELD}%gs${FIELD}%ct`, '-n', String(limit)], { readOnly: true });
  return out ? parseReflog(out.stdout) : [];
}

/** `rebase` and `pull --rebase` (whatever flags GitGood passes, or a `pull.rebase` config pull) log one entry per replayed commit; undoing one means undoing the whole run. */
const REBASE_RE = /^(rebase\b|pull\b.*(\s--rebase\b|\([a-z-]+\)$))/;
const REBASE_START_RE = /\(start\)$/;
const LABELS: [RegExp, string][] = [
  [/^commit \(amend\)/, 'Amend'],
  [/^commit \(merge\)/, 'Merge commit'],
  [/^commit/, 'Commit'],
  [/^merge\b/, 'Merge'],
  [/^pull\b.*\s--rebase\b/, 'Pull (rebase)'],
  [/^pull\b/, 'Pull'],
  [/^rebase\b/, 'Rebase'],
  [/^cherry-pick/, 'Cherry-pick'],
  [/^revert/, 'Revert'],
  [/^reset/, 'Reset'],
];

function describeEntry(e: ReflogEntry): string {
  const label = LABELS.find(([re]) => re.test(e.action))?.[1] ?? e.action;
  return REBASE_RE.test(e.action) || !e.message ? label : `${label}: ${e.message}`;
}

/**
 * The "Undo last Git operation" target for a newest-first HEAD reflog: the newest entry that actually moved HEAD
 * (skipping `reset --hard HEAD`-style no-ops and aborted rebases). A checkout is undone by switching back; anything else
 * by resetting to the state before it (before the whole run for a rebase). `localBranches` tells a branch from a detached commit.
 */
export function planUndo(entries: ReflogEntry[], localBranches: ReadonlySet<string>): UndoPlan | null {
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.action === 'checkout') {
      const m = /^moving from (\S+) to (\S+)$/.exec(e.message);
      if (!m) return null;
      if (m[1] === m[2]) {
        i += 1;
        continue;
      }
      const isBranch = localBranches.has(m[1]);
      if (!isBranch && !/^[0-9a-f]{40}$/.test(m[1])) return null;
      return { kind: 'checkout', description: `Checkout of ${m[2]}`, ref: m[1], isBranch };
    }
    let next = i + 1;
    // A rebase run ends at its `(start)` entry; the run before it is a separate undo step.
    if (REBASE_RE.test(e.action)) {
      next = i;
      while (next < entries.length && REBASE_RE.test(entries[next].action)) if (REBASE_START_RE.test(entries[next++].action)) break;
    }
    const target = entries[next];
    if (!target) return null;
    if (target.sha === e.sha) {
      i = next;
      continue;
    }
    return { kind: 'reset', description: describeEntry(e), target };
  }
  return null;
}

export async function getUndoPlan(git: GitClient, repoPath: string): Promise<UndoPlan | null> {
  const entries = await getReflog(git, repoPath, 500);
  const branches = await git.tryRun(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { readOnly: true });
  return planUndo(entries, new Set((branches?.stdout ?? '').split('\n').filter(Boolean)));
}

const LOCAL_CHANGES_RE = /not uptodate|would be overwritten|Cannot merge/i;

/**
 * Moves the current branch (or detached HEAD) to `sha` with `reset --keep`: uncommitted changes survive unless they
 * overlap files that differ, in which case git refuses (surfaced as `local-changes-overwritten`). With `stashFirst`
 * the local changes are stashed (untracked included) before resetting.
 */
export async function resetKeep(git: GitClient, repoPath: string, sha: string, stashFirst: boolean): Promise<void> {
  assertNotOption(sha);
  if (stashFirst) {
    const dirty = (await git.stdout(repoPath, ['status', '--porcelain'], { readOnly: true })).trim();
    if (dirty) {
      const branch = (await git.stdout(repoPath, ['branch', '--show-current'], { readOnly: true })).trim();
      await ops.stashPush(git, repoPath, 'Stashed before restoring an earlier state', true, null, branch || null);
    }
  }
  try {
    await git.run(repoPath, ['reset', '--keep', sha]);
  } catch (err) {
    if (err instanceof GitError && err.info.code !== 'local-changes-overwritten' && LOCAL_CHANGES_RE.test(`${err.info.stderr}\n${err.info.message}`)) {
      throw new GitError({ ...err.info, code: 'local-changes-overwritten' });
    }
    throw err;
  }
}
