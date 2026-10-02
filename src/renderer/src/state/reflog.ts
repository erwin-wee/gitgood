import type { Branch } from '@shared/types';
import { shortSha } from '@shared/util';
import { errorInfo, invoke } from '../api';
import { checkoutBranch, checkoutCommit, loadHistory, refreshAll, runOperation, selectCommit, setView, showError } from './actions';
import { closeAllDialogs, openDialog, showToast, store } from './store';

// ---------------------------------------------------------------------------
// Undo history (reflog)
// ---------------------------------------------------------------------------

/**
 * Confirms, then moves the current branch (or detached HEAD) to `sha` with `reset --keep`. When git refuses because
 * uncommitted changes overlap files that differ, offers to stash them and retry.
 */
export function restoreBranchTo(sha: string, what: string, opts: { title?: string; intro?: string } = {}): void {
  const { currentRepo: repo, status } = store.get();
  if (!repo || !status) return;
  const head = status.branch;
  const subject = head.detached || !head.name ? 'The detached HEAD' : `Branch ${head.name}`;
  const run = async (stashFirst: boolean): Promise<void> => {
    try {
      await invoke('git.resetKeep', repo.path, sha, stashFirst);
      closeAllDialogs();
      await refreshAll();
      await loadHistory(true);
      showToast({ kind: 'success', title: `Restored to ${shortSha(sha)}`, message: what, action: { label: 'Undo history', onClick: () => openDialog({ kind: 'reflog' }) } }, 10000);
    } catch (err) {
      if (!stashFirst && errorInfo(err).code === 'local-changes-overwritten') {
        openDialog({
          kind: 'confirm',
          title: 'Stash your changes first?',
          message: 'Some uncommitted changes touch files that differ at that point, so they cannot be kept in place. Stash them (untracked files included) and restore? Pop the stash afterwards to get them back.',
          confirmLabel: 'Stash and restore',
          onConfirm: () => run(true),
        });
      } else {
        showError('Could not restore', err);
      }
    }
  };
  openDialog({
    kind: 'confirm',
    title: opts.title ?? 'Restore to this point?',
    message: `${opts.intro ? `${opts.intro}\n\n` : ''}${subject} will move from ${shortSha(head.sha ?? '')} back to ${shortSha(sha)} (${what}).\n\nCommits made after that point leave it and the files return to how they were then; they stay recoverable from Undo history for a while. Uncommitted changes are kept.`,
    confirmLabel: 'Restore',
    danger: true,
    onConfirm: () => run(false),
  });
}

/** "Undo last Git operation": resets to the state before the newest HEAD-moving reflog entry, or offers to switch back after a checkout. */
export async function undoLastOperation(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  let plan;
  try {
    plan = await invoke('repo.undoPlan', repo.path);
  } catch (err) {
    showError('Could not read the reflog', err);
    return;
  }
  if (!plan) {
    showToast({ kind: 'info', title: 'Nothing to undo' });
  } else if (plan.kind === 'reset') {
    restoreBranchTo(plan.target.sha, `${plan.target.action}${plan.target.message ? `: ${plan.target.message}` : ''}`, { title: 'Undo last Git operation?', intro: `Last operation: ${plan.description}.` });
  } else if (!plan.isBranch) {
    await checkoutCommit(plan.ref);
  } else {
    const ref = plan.ref;
    const branch: Branch | undefined = store.get().branches.find((b) => b.kind === 'local' && b.name === ref);
    if (!branch) {
      showToast({ kind: 'warning', title: 'Cannot switch back', message: `Branch ${ref} no longer exists.` });
      return;
    }
    openDialog({
      kind: 'confirm',
      title: 'Undo last Git operation?',
      message: `Last operation: ${plan.description}.\n\nSwitch back to branch ${ref}?`,
      confirmLabel: 'Switch back',
      onConfirm: () => checkoutBranch(branch),
    });
  }
}

// ---------------------------------------------------------------------------
// Bisect
// ---------------------------------------------------------------------------

export async function startBisect(bad: string, good: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const started = await runOperation('Starting bisect', async () => {
    await invoke('git.bisect.start', repo.path, bad, good);
    return true;
  });
  if (started) closeAllDialogs();
}

/** Marks `sha` (null: the commit currently checked out) as good, bad or skipped. */
export async function markBisect(verb: 'good' | 'bad' | 'skip', sha: string | null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await runOperation(`Bisect: ${verb}`, () => invoke('git.bisect.mark', repo.path, verb, sha));
}

export async function resetBisect(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await runOperation('Ending bisect', () => invoke('git.bisect.reset', repo.path));
  await loadHistory(true);
}

/** History context menu "mark good": the bad end defaults to HEAD. "Mark bad" has no sensible default, so it asks for the good end. */
export function startBisectFrom(sha: string, label: string, as: 'good' | 'bad'): void {
  if (as === 'good') void startBisect('HEAD', sha);
  else openDialog({ kind: 'bisect-start', bad: sha, badLabel: label });
}

export function openBisectResult(sha: string): void {
  setView('history');
  selectCommit(sha);
}
