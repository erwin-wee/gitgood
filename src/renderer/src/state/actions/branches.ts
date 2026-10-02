import type { AddWorktreeOptions, Branch, UncommittedChangesStrategy, Worktree } from '@shared/types';
import { extractWorktreePathFromError } from '@shared/util';
import { errorInfo, errorMessage, invoke } from '../../api';
import { closeAllDialogs, closeDialog, openDialog, patchChanges, showToast, store } from '../store';
import { runOperation, showError } from './core';
import { openRepository, refreshAll, refreshStatus } from './repo';
import { loadHistory, setView } from './view';
import { loadCurrentPullRequest } from './github';
import { reportOutcome, withUncommittedChanges } from './shared';

// ---------------------------------------------------------------------------
// Sync: fetch / pull / push
// ---------------------------------------------------------------------------

export async function fetchRemote(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await runOperation('Fetch', () => invoke('git.fetch', repo.path, null));
  void loadCurrentPullRequest(true);
}

export async function pull(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Pull', () => invoke('git.pull', repo.path));
  if (outcome?.status === 'conflicts') reportOutcome(outcome, 'Pull');
  else if (outcome?.status === 'complete') showToast({ kind: 'success', title: 'Pulled latest changes' });
  void loadCurrentPullRequest(true);
}

export async function push(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.status) return;
  const branch = s.status.branch;
  if (branch.behind > 0 && !force) {
    if (s.settings?.confirmForcePush !== false) {
      openDialog({ kind: 'force-push' });
      return;
    }
    force = true;
  }
  const setUpstream = !branch.upstream || branch.upstreamGone;
  const remote = s.remotes.find((r) => r.name === 'origin')?.name ?? s.remotes[0]?.name ?? null;
  if (!remote) {
    openDialog({ kind: 'publish' });
    return;
  }
  const result = await runOperation(force ? 'Force push' : 'Push', () => invoke('git.push', repo.path, { force, setUpstream, remote: setUpstream ? remote : null, branch: null, tags: false }), { silent: true });
  if (result === undefined) {
    // runOperation swallowed the error silently; re-run to obtain it for classification.
    return;
  }
  showToast({ kind: 'success', title: setUpstream ? `Published ${branch.name}` : 'Pushed' });
  void loadCurrentPullRequest(true);
}

export async function pushWithErrorHandling(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.status) return;
  const branch = s.status.branch;
  if (branch.behind > 0 && !force) {
    if (s.settings?.confirmForcePush !== false) {
      openDialog({ kind: 'force-push' });
      return;
    }
    force = true;
  }
  const setUpstream = !branch.upstream || branch.upstreamGone;
  const remote = s.remotes.find((r) => r.name === 'origin')?.name ?? s.remotes[0]?.name ?? null;
  if (!remote) {
    openDialog({ kind: 'publish' });
    return;
  }
  store.set({ operation: force ? 'Force push' : 'Push' });
  try {
    await invoke('git.push', repo.path, { force, setUpstream, remote: setUpstream ? remote : null, branch: null, tags: false });
    showToast({ kind: 'success', title: setUpstream ? `Published ${branch.name}` : 'Pushed' });
    void loadCurrentPullRequest(true);
  } catch (err) {
    const info = errorInfo(err);
    if (info.code === 'non-fast-forward') {
      await refreshStatus();
      openDialog({ kind: 'force-push' });
    } else if (info.code === 'protected-branch') {
      showError('Push rejected by branch protection', err);
    } else {
      showError('Push failed', err);
    }
  } finally {
    store.set({ operation: null });
    void refreshAll();
  }
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export function hasUncommittedChanges(): boolean {
  const status = store.get().status;
  return !!status && status.files.length > 0;
}

/** Opens the repository at `path` (registering it if it is a worktree GitGood has not seen before). */
export async function openWorktreeAtPath(path: string): Promise<void> {
  try {
    const info = await invoke('repo.open', path);
    closeAllDialogs();
    await openRepository(info);
  } catch (err) {
    showError('Could not open that worktree', err);
  }
}

/** Reports a "branch is checked out in another worktree" error with an action to open it; returns true when it handled the error. */
function reportWorktreeConflict(err: unknown, branchName: string): boolean {
  const info = errorInfo(err);
  if (info.code !== 'worktree-branch-in-use') return false;
  const path = extractWorktreePathFromError(info.message);
  showToast(
    {
      kind: 'warning',
      title: `${branchName} is checked out in another worktree`,
      message: path ?? info.message,
      action: path ? { label: 'Open that worktree', onClick: () => void openWorktreeAtPath(path) } : undefined,
    },
    12000,
  );
  return true;
}

export async function checkoutBranch(branch: Branch): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  if (branch.isCurrent) return;
  await withUncommittedChanges(branch.name, async (strategy) => {
    closeAllDialogs();
    store.set({ operation: `Switching to ${branch.name}`, popover: null });
    try {
      if (branch.kind === 'remote') await invoke('git.checkoutRemoteBranch', repo.path, branch.name, strategy);
      else await invoke('git.checkout', repo.path, branch.name, strategy);
      patchChanges({ summary: '', description: '', amend: false });
      await refreshAll();
      await loadHistory(true);
      void loadCurrentPullRequest(true);
    } catch (err) {
      const info = errorInfo(err);
      if (info.code === 'local-changes-overwritten' && strategy === 'move') {
        openDialog({ kind: 'uncommitted-changes', targetLabel: branch.name, proceed: (st) => checkoutBranchWith(branch, st) });
      } else if (!reportWorktreeConflict(err, branch.name)) {
        showError(`Could not switch to ${branch.name}`, err);
      }
    } finally {
      store.set({ operation: null });
    }
  });
}

async function checkoutBranchWith(branch: Branch, strategy: UncommittedChangesStrategy): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  store.set({ operation: `Switching to ${branch.name}` });
  try {
    if (branch.kind === 'remote') await invoke('git.checkoutRemoteBranch', repo.path, branch.name, strategy);
    else await invoke('git.checkout', repo.path, branch.name, strategy);
    await refreshAll();
    await loadHistory(true);
  } catch (err) {
    if (!reportWorktreeConflict(err, branch.name)) showError(`Could not switch to ${branch.name}`, err);
  } finally {
    store.set({ operation: null });
  }
}

export async function createBranch(name: string, startPoint: string | null, checkout = true): Promise<boolean> {
  const repo = store.get().currentRepo;
  if (!repo) return false;
  let ok = false;
  await withUncommittedChanges(name, async (strategy) => {
    closeAllDialogs();
    store.set({ operation: `Creating ${name}` });
    try {
      await invoke('git.branch.create', repo.path, name, startPoint, checkout, strategy);
      ok = true;
      await refreshAll();
      await loadHistory(true);
      void loadCurrentPullRequest(true);
    } catch (err) {
      const info = errorInfo(err);
      if (info.code === 'local-changes-overwritten') {
        openDialog({ kind: 'uncommitted-changes', targetLabel: name, proceed: async (st) => { await invoke('git.branch.create', repo.path, name, startPoint, checkout, st); await refreshAll(); } });
      } else if (!reportWorktreeConflict(err, name)) showError(`Could not create branch ${name}`, err);
    } finally {
      store.set({ operation: null });
    }
  });
  return ok;
}

export async function renameBranch(oldName: string, newName: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.branch.rename', repo.path, oldName, newName);
    closeDialog();
    await refreshAll();
  } catch (err) {
    showError('Could not rename branch', err);
  }
}

export async function deleteBranch(branch: Branch, deleteRemote: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    if (branch.kind === 'remote') {
      const slash = branch.name.indexOf('/');
      await invoke('git.branch.deleteRemote', repo.path, branch.name.slice(0, slash), branch.name.slice(slash + 1));
    } else {
      await invoke('git.branch.delete', repo.path, branch.name, deleteRemote);
    }
    closeDialog();
    showToast({ kind: 'success', title: `Deleted ${branch.name}` });
    await refreshAll();
  } catch (err) {
    showError('Could not delete branch', err);
  }
}

export async function mergeBranch(branch: string, squash: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  const outcome = await runOperation(squash ? 'Squash merge' : 'Merge', () => invoke('git.merge', repo.path, branch, squash));
  if (outcome?.status === 'complete') {
    if (squash) {
      patchChanges({ summary: `Squashed commit of ${branch}`, description: '' });
      showToast({ kind: 'success', title: `Squashed ${branch}`, message: 'Review the staged changes and commit them.' });
      setView('changes');
    } else {
      store.set({ lastSuccessfulMerge: { branch, at: Date.now() } });
      showToast({ kind: 'success', title: `Merged ${branch} into ${store.get().status?.branch.name ?? 'current branch'}` });
      await loadHistory(true);
    }
  } else reportOutcome(outcome, 'Merge');
}

export async function rebaseOnto(branch: string, updateRefs = false): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  const outcome = await runOperation('Rebase', () => invoke('git.rebase', repo.path, branch, updateRefs));
  if (outcome?.status === 'complete') {
    showToast({ kind: 'success', title: `Rebased onto ${branch}` });
    await loadHistory(true);
  } else reportOutcome(outcome, 'Rebase');
}

/** Force-pushes (with lease) the current branch and the branches stacked below it, after confirming the list. */
export function pushStack(): void {
  const s = store.get();
  const repo = s.currentRepo;
  const current = s.status?.branch.name;
  if (!repo || !current || !s.stack.parents.length) return;
  const branches = [...s.stack.parents, current];
  openDialog({
    kind: 'confirm',
    title: 'Push stack?',
    message: `Force-push (with lease) ${branches.length} branches, overwriting their remote versions:\n\n${branches.join('\n')}`,
    confirmLabel: 'Push stack',
    danger: true,
    onConfirm: async () => {
      const pushed = await runOperation('Push stack', () => invoke('git.pushStack', repo.path));
      if (pushed) showToast({ kind: 'success', title: `Pushed ${pushed.length} stacked branches` });
      void loadCurrentPullRequest(true);
    },
  });
}

export async function updateFromDefaultBranch(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Update from default branch', () => invoke('git.updateFromDefaultBranch', repo.path));
  reportOutcome(outcome, 'Update');
  if (outcome?.status === 'complete') await loadHistory(true);
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export async function addWorktree(opts: AddWorktreeOptions): Promise<boolean> {
  const repo = store.get().currentRepo;
  if (!repo) return false;
  try {
    const info = await invoke('git.worktree.add', repo.path, opts);
    closeAllDialogs();
    showToast({ kind: 'success', title: `Worktree added at ${info.path}` });
    await openRepository(info);
    return true;
  } catch (err) {
    if (!reportWorktreeConflict(err, opts.branch ?? opts.newBranch ?? '')) showError('Could not add worktree', err);
    return false;
  }
}

export async function removeWorktree(worktree: Worktree, force: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.worktree.remove', repo.path, worktree.path, force);
    closeDialog();
    showToast({ kind: 'success', title: 'Worktree removed' });
    const list = store.get().repos;
    if (store.get().currentRepo?.path === worktree.path) {
      const next = list.filter((r) => !r.missing && r.path !== worktree.path).sort((a, b) => b.lastOpened - a.lastOpened)[0];
      if (next) await openRepository(next);
    }
    await invoke('repos.refreshIndicators').catch(() => undefined);
  } catch (err) {
    showError('Could not remove worktree', err);
  }
}

export async function lockWorktree(worktree: Worktree, locked: boolean, reason: string | null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.worktree.lock', repo.path, worktree.path, locked, reason);
    closeDialog();
  } catch (err) {
    showError(locked ? 'Could not lock worktree' : 'Could not unlock worktree', err);
  }
}

export async function pruneWorktrees(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.worktree.prune', repo.path);
    closeDialog();
    showToast({ kind: 'success', title: 'Pruned worktrees' });
  } catch (err) {
    showError('Could not prune worktrees', err);
  }
}

export async function openInEditorAt(path: string): Promise<void> {
  try {
    await invoke('app.openInEditor', path, null);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open editor', message: errorMessage(err) });
  }
}

export async function openInShellAt(path: string): Promise<void> {
  try {
    await invoke('app.openInShell', path);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open terminal', message: errorMessage(err) });
  }
}

export async function showInFolderAt(path: string): Promise<void> {
  await invoke('app.openPath', path);
}
