import type { Stash } from '@shared/types';
import { errorMessage, invoke } from '../../api';
import { closeAllDialogs, closeDialog, openDialog, patchDiff, patchStashesView, showToast, store } from '../store';
import { showError } from './core';
import { refreshAll, refreshStatus } from './repo';
import { refreshStashes } from './conflicts';
import { loadDiff, setView } from './view';

// ---------------------------------------------------------------------------
// Discard / stash / ignore
// ---------------------------------------------------------------------------

export function requestDiscard(paths: string[], all = false): void {
  const settings = store.get().settings;
  if (settings?.confirmDiscardChanges === false) void discard(paths, all);
  else openDialog({ kind: 'discard', paths, all });
}

export async function discard(paths: string[], all: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  const trash = store.get().settings?.confirmDiscardChangesPermanently !== false;
  try {
    if (all) await invoke('git.discardAll', repo.path, trash);
    else await invoke('git.discard', repo.path, paths, trash);
    await refreshStatus();
    await loadDiff(true);
  } catch (err) {
    showError('Could not discard changes', err);
  }
}

export async function discardPatch(patch: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  try {
    await invoke('git.discardPatch', repo.path, patch);
    patchDiff({ selectedLines: null });
    await refreshStatus();
    await loadDiff(true);
  } catch (err) {
    showError('Could not discard selected lines', err);
  }
}

export async function ignore(patterns: string[]): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('repo.gitignore.add', repo.path, patterns);
    await refreshStatus();
  } catch (err) {
    showError('Could not update .gitignore', err);
  }
}

export async function stashAll(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const s = store.get();
  const existing = s.stashes.find((st) => st.createdByApp && st.branch === s.status?.branch.name);
  const perform = async () => {
    try {
      if (existing) await invoke('git.stash.drop', repo.path, existing.sha);
      await invoke('git.stash.push', repo.path, null, true, null);
      await refreshAll();
      await loadDiff(true);
      showToast({ kind: 'success', title: 'Changes stashed', action: { label: 'View stashes', onClick: () => setView('stashes') } }, 10000);
    } catch (err) {
      showError('Could not stash changes', err);
    }
  };
  if (existing && s.settings?.confirmDiscardStash !== false) {
    openDialog({ kind: 'confirm', title: 'Overwrite stash?', message: `A stash created by GitGood already exists on ${s.status?.branch.name}. Stashing again will overwrite it.`, confirmLabel: 'Overwrite', danger: true, onConfirm: perform });
  } else await perform();
}

// ---------------------------------------------------------------------------
// Stashes view
// ---------------------------------------------------------------------------

export async function loadStashesView(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  patchStashesView({ loading: true });
  try {
    const stashes = await invoke('repo.stashes', repo.path);
    if (store.get().currentRepo?.path !== repo.path) return;
    store.set({ stashes });
    const v = store.get().stashesView;
    if (v.selectedSha && !stashes.some((st) => st.sha === v.selectedSha)) patchStashesView({ selectedSha: null, files: [], selectedFile: null });
    else if (!v.selectedSha && stashes.length) void selectStash(stashes[0].sha);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not load stashes', message: errorMessage(err) });
  } finally {
    patchStashesView({ loading: false });
  }
}

export async function selectStash(sha: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const stash = store.get().stashes.find((st) => st.sha === sha);
  if (!stash) return;
  patchStashesView({ selectedSha: sha, files: [], selectedFile: null, filesLoading: true });
  try {
    const files = await invoke('repo.stash.files', repo.path, stash.sha);
    if (store.get().stashesView.selectedSha !== sha) return;
    patchStashesView({ files, selectedFile: files[0]?.path ?? null, filesLoading: false });
    void loadDiff();
  } catch (err) {
    if (store.get().stashesView.selectedSha !== sha) return;
    patchStashesView({ filesLoading: false });
    showToast({ kind: 'error', title: 'Could not load stash', message: errorMessage(err) });
  }
}

export function selectStashViewFile(path: string): void {
  patchStashesView({ selectedFile: path });
  void loadDiff();
}

async function restoreStashInternal(stash: Stash, pop: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  store.set({ operation: pop ? 'Pop stash' : 'Apply stash' });
  try {
    const outcome = await invoke(pop ? 'git.stash.pop' : 'git.stash.apply', repo.path, stash.sha);
    if (outcome.status === 'conflicts') {
      showToast({ kind: 'warning', title: 'Stash restored with conflicts', message: 'Resolve the conflicted files, then the stash can be dropped.' });
    } else if (outcome.status === 'complete') {
      if (pop && store.get().stashesView.selectedSha === stash.sha) patchStashesView({ selectedSha: null, files: [], selectedFile: null });
      showToast({ kind: 'success', title: pop ? 'Stash popped' : 'Stash applied' });
    }
  } catch (err) {
    showError('Could not restore stash', err);
  } finally {
    store.set({ operation: null });
    await refreshAll();
    await loadDiff(true);
  }
}

/** Applies a stash to the working tree, keeping it in the list. */
export async function applyStash(stash: Stash): Promise<void> {
  await restoreStashInternal(stash, false);
}

/** Applies a stash and, if it applied cleanly, drops it. */
export async function popStash(stash: Stash): Promise<void> {
  await restoreStashInternal(stash, true);
}

export async function dropStashView(stash: Stash): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const perform = async () => {
    try {
      await invoke('git.stash.drop', repo.path, stash.sha);
      if (store.get().stashesView.selectedSha === stash.sha) patchStashesView({ selectedSha: null, files: [], selectedFile: null });
      await refreshStashes();
      void loadDiff();
      showToast({ kind: 'success', title: 'Stash dropped' });
    } catch (err) {
      showError('Could not discard stash', err);
    }
  };
  if (store.get().settings?.confirmDiscardStash !== false) {
    const fileCountLabel = stash.fileCount !== null ? `, ${stash.fileCount} file${stash.fileCount === 1 ? '' : 's'}` : '';
    openDialog({
      kind: 'confirm',
      title: 'Discard stash?',
      message: `"${stash.message}" (${stash.branch ? `on ${stash.branch}` : 'unknown branch'}${fileCountLabel}) will be permanently lost. It cannot be recovered from GitGood.`,
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: perform,
    });
  } else await perform();
}

export async function createBranchFromStash(stash: Stash, branchName: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  store.set({ operation: `Creating ${branchName}` });
  try {
    const outcome = await invoke('git.stash.branch', repo.path, stash.sha, branchName);
    if (outcome.status === 'complete') {
      if (store.get().stashesView.selectedSha === stash.sha) patchStashesView({ selectedSha: null, files: [], selectedFile: null });
      showToast({ kind: 'success', title: `Branch ${branchName} created`, message: 'The stash was applied to it and removed.' });
      setView('changes');
    }
  } catch (err) {
    showError(`Could not create branch ${branchName}`, err);
  } finally {
    store.set({ operation: null });
    await refreshAll();
  }
}

/** Stashes only the given paths, leaving the rest of the working tree untouched (`git stash push -- <paths>`). */
export async function stashSelectedFiles(paths: string[], message: string, includeUntracked: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo || !paths.length) return;
  closeDialog();
  try {
    await invoke('git.stash.push', repo.path, message.trim() || null, includeUntracked, paths);
    await refreshStatus();
    await refreshStashes();
    await loadDiff(true);
    showToast({ kind: 'success', title: paths.length === 1 ? 'File stashed' : `${paths.length} files stashed`, action: { label: 'View stashes', onClick: () => setView('stashes') } }, 10000);
  } catch (err) {
    showError('Could not stash selected files', err);
  }
}
