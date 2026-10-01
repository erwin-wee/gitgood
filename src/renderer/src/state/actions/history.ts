import type { Branch } from '@shared/types';
import { invoke } from '../../api';
import { closeAllDialogs, closeDialog, openDialog, patchHistory, showToast, store } from '../store';
import { runOperation, showError } from './core';
import { refreshAll } from './repo';
import { loadTags } from './conflicts';
import { loadHistory } from './view';
import { reportOutcome, withUncommittedChanges } from './shared';

// ---------------------------------------------------------------------------
// History operations
// ---------------------------------------------------------------------------

export async function revertCommit(sha: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Revert', () => invoke('git.revert', repo.path, sha));
  reportOutcome(outcome, 'Revert');
  if (outcome?.status === 'complete') await loadHistory(true);
}

export async function cherryPickTo(shas: string[], branch: Branch): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  if (!branch.isCurrent) {
    let switched = false;
    await withUncommittedChanges(branch.name, async (strategy) => {
      try {
        if (branch.kind === 'remote') await invoke('git.checkoutRemoteBranch', repo.path, branch.name, strategy);
        else await invoke('git.checkout', repo.path, branch.name, strategy);
        switched = true;
      } catch (err) {
        showError(`Could not switch to ${branch.name}`, err);
      }
    });
    if (!switched) return;
  }
  // cherry-pick expects oldest first
  const ordered = [...shas].reverse();
  const outcome = await runOperation('Cherry-pick', () => invoke('git.cherryPick', repo.path, ordered));
  reportOutcome(outcome, 'Cherry-pick');
  await loadHistory(true);
}

export async function squashCommits(shas: string[], targetSha: string, message: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  const outcome = await runOperation('Squash', () => invoke('git.squash', repo.path, { shas, targetSha, message }));
  reportOutcome(outcome, 'Squash');
  patchHistory({ selectedShas: [] });
  await loadHistory(true);
}

export async function reorderCommits(shas: string[], beforeSha: string | null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Reorder', () => invoke('git.reorder', repo.path, shas, beforeSha));
  reportOutcome(outcome, 'Reorder');
  await loadHistory(true);
}

export async function rewordCommit(sha: string, message: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  const outcome = await runOperation('Edit message', () => invoke('git.reword', repo.path, sha, message));
  reportOutcome(outcome, 'Edit message');
  await loadHistory(true);
}

export async function dropCommit(sha: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Drop commit', () => invoke('git.dropCommit', repo.path, sha));
  reportOutcome(outcome, 'Drop');
  patchHistory({ selectedShas: [] });
  await loadHistory(true);
}

export async function createTag(name: string, sha: string, message: string | null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.tag.create', repo.path, name, sha, message);
    closeDialog();
    showToast({ kind: 'success', title: `Created tag ${name}`, action: { label: 'Push tag', onClick: () => void runOperation('Push tag', () => invoke('git.tag.push', repo.path, name)) } });
    await loadHistory(true);
  } catch (err) {
    showError('Could not create tag', err);
  }
}

export async function deleteTag(name: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  openDialog({
    kind: 'confirm',
    title: `Delete tag ${name}?`,
    message: 'The tag will be deleted locally and, if it was pushed, on origin.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      try {
        await invoke('git.tag.delete', repo.path, name, true);
        await loadHistory(true);
        await loadTags();
      } catch (err) {
        showError('Could not delete tag', err);
      }
    },
  });
}

export async function checkoutCommit(sha: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const perform = async () => {
    await withUncommittedChanges(sha.slice(0, 7), async (strategy) => {
      closeAllDialogs();
      try {
        if (strategy === 'stash') await invoke('git.stash.push', repo.path, 'Stashed before checking out commit', true, null);
        await invoke('git.checkoutCommit', repo.path, sha);
        await refreshAll();
        await loadHistory(true);
      } catch (err) {
        showError('Could not check out commit', err);
      }
    });
  };
  if (store.get().settings?.confirmCheckoutCommit !== false) {
    openDialog({ kind: 'confirm', title: 'Check out commit?', message: `Checking out ${sha.slice(0, 7)} detaches HEAD from the current branch. Create a branch afterwards to keep any new commits.`, confirmLabel: 'Check out', onConfirm: perform });
  } else await perform();
}
