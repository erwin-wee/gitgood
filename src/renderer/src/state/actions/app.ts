import type { BranchDeleteResult, RepoWork, StaleBranch, AppSettings, UpdateState } from '@shared/types';
import { errorMessage, invoke } from '../../api';
import { openDialog, showToast, store } from '../store';
import { showError } from './core';
import { openRepository } from './repo';
import { refreshBranches } from './conflicts';
import { loadDiff, loadHistory, setView } from './view';
import { checkoutBranch } from './branches';
import { openExternal } from './github';
import { applyTheme } from './shared';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  try {
    const settings = await invoke('app.settings.set', patch);
    store.set({ settings });
    applyTheme(settings, store.get().dark);
    if (patch.diffHideWhitespace !== undefined) void loadDiff(true);
    if (patch.historyGraph !== undefined) void loadHistory(true);
    if (patch.blameIgnoreWhitespace !== undefined && store.get().diff.blameOn) void loadDiff(true);
  } catch (err) {
    showError('Could not save settings', err);
  }
}

// ---------------------------------------------------------------------------
// External
// ---------------------------------------------------------------------------

export async function openInEditor(filePath: string | null = null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('app.openInEditor', repo.path, filePath);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open editor', message: errorMessage(err), action: { label: 'Settings', onClick: () => openDialog({ kind: 'settings', tab: 'integrations' }) } });
  }
}

export async function openInShell(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('app.openInShell', repo.path);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open terminal', message: errorMessage(err), action: { label: 'Settings', onClick: () => openDialog({ kind: 'settings', tab: 'integrations' }) } });
  }
}

export async function openDiffTool(path: string, source: { kind: 'working' } | { kind: 'commit'; sha: string }): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('app.openDiffTool', repo.path, path, source);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open diff tool', message: errorMessage(err) });
  }
}

/** The merge tool refreshes repo state itself when it exits (main sends `repo.changed`). */
export async function openMergeTool(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('app.openMergeTool', repo.path, path);
    showToast({ kind: 'info', title: 'Merge tool started', message: 'Save and close it to pick up the result.' });
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open merge tool', message: errorMessage(err) });
  }
}

export async function showInFolder(filePath: string | null = null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  if (filePath) {
    const full = await invoke('app.joinPath', repo.path, ...filePath.split('/'));
    await invoke('app.showItemInFolder', full);
  } else {
    await invoke('app.openPath', repo.path);
  }
}

export async function copyToClipboard(text: string, label = 'Copied'): Promise<void> {
  await invoke('app.clipboard.write', text);
  showToast({ kind: 'info', title: label }, 1500);
}

// ---------------------------------------------------------------------------
// Repository health
// ---------------------------------------------------------------------------

export function openHealth(): void {
  if (!store.get().currentRepo) {
    showToast({ kind: 'info', title: 'Open a repository first' });
    return;
  }
  setView('health');
}

/** Fetches unpushed work across every repository on disk, for the Welcome screen card and (opt-in) the repository list's warning dot. Best-effort: failures leave the previous data in place. */
export async function loadWork(): Promise<void> {
  try {
    const work = await invoke('repos.work');
    store.set({ work, workError: null });
  } catch (err) {
    store.set({ workError: errorMessage(err) });
  }
}

/** Opens the repository a work entry refers to, optionally checking out one of its branches (used by the Unpushed work card and the Welcome screen). */
export async function openRepoWorkEntry(work: RepoWork, branch?: string): Promise<void> {
  const repo = store.get().repos.find((r) => r.id === work.repoId);
  if (!repo) return;
  await openRepository(repo);
  if (branch) {
    const target = store.get().branches.find((b) => b.kind === 'local' && b.name === branch);
    if (target && !target.isCurrent) await checkoutBranch(target);
  }
}

export function openBulkDeleteBranches(branches: StaleBranch[]): void {
  if (!branches.some((b) => !b.protected)) {
    showToast({ kind: 'info', title: 'Nothing to delete', message: 'The current, default and protected branches cannot be deleted here.' });
    return;
  }
  openDialog({ kind: 'bulk-delete-branches', branches });
}

export async function bulkDeleteStaleBranches(names: string[], deleteRemote: boolean): Promise<BranchDeleteResult | null> {
  const repo = store.get().currentRepo;
  if (!repo || !names.length) return null;
  try {
    const result = await invoke('git.branch.deleteMany', repo.path, names, deleteRemote);
    await refreshBranches();
    if (result.deleted.length) {
      showToast(
        {
          kind: result.failed.length ? 'warning' : 'success',
          title: `Deleted ${result.deleted.length} branch${result.deleted.length === 1 ? '' : 'es'}`,
          message: result.failed.length ? `${result.failed.length} could not be deleted: ${result.failed.map((f) => f.name).join(', ')}` : undefined,
          action: { label: 'Undo', onClick: () => void undoBulkDeleteBranches(result.deleted) },
        },
        12000,
      );
    } else if (result.failed.length) {
      showToast({ kind: 'error', title: 'Could not delete the selected branches', message: result.failed.map((f) => `${f.name}: ${f.message}`).join('\n') });
    }
    return result;
  } catch (err) {
    showError('Could not delete branches', err);
    return null;
  }
}

/** Recreates locally deleted branches at their recorded tip SHAs (git keeps the objects reachable through the reflog until it next expires, so this is safe soon after deletion). */
export async function undoBulkDeleteBranches(deleted: { name: string; sha: string }[]): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  let restored = 0;
  for (const { name, sha } of deleted) {
    try {
      await invoke('git.branch.create', repo.path, name, sha, false, 'ask');
      restored++;
    } catch (err) {
      showError(`Could not restore ${name}`, err);
    }
  }
  if (restored) {
    await refreshBranches();
    showToast({ kind: 'success', title: restored === 1 ? 'Branch restored' : `${restored} branches restored` });
  }
}

/** `onDone` is called after a successful run, so the Housekeeping card can reload its numbers. */
export function confirmPruneRemotes(onDone?: () => void): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const remotes = store.get().remotes;
  if (!remotes.length) {
    showToast({ kind: 'info', title: 'No remotes configured' });
    return;
  }
  openDialog({
    kind: 'confirm',
    title: 'Prune remote-tracking branches?',
    message: `Removes local refs (e.g. ${remotes[0].name}/old-feature) for branches that no longer exist on ${remotes.map((r) => r.name).join(', ')}. This never touches your local branches.`,
    confirmLabel: 'Continue',
    onConfirm: () =>
      openDialog({
        kind: 'confirm',
        title: 'Confirm prune',
        message: 'Local remote-tracking branches the remote no longer has will be deleted. This cannot be undone (your local branches are never affected).',
        confirmLabel: 'Prune remotes',
        danger: true,
        onConfirm: async () => {
          let failed = 0;
          for (const remote of remotes) {
            try {
              await invoke('git.remote.prune', repo.path, remote.name);
            } catch (err) {
              failed++;
              showError(`Could not prune ${remote.name}`, err);
            }
          }
          await refreshBranches();
          if (failed < remotes.length) showToast({ kind: 'success', title: 'Pruned remote-tracking branches' });
          onDone?.();
        },
      }),
  });
}

/** `onDone` is called after a successful run, so the Housekeeping card can reload its numbers. */
export function confirmRunGc(onDone?: () => void): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  openDialog({
    kind: 'confirm',
    title: 'Run garbage collection?',
    message: 'Git will repack loose objects and drop ones that are no longer reachable from any branch, tag or the reflog. This can take a while on a large repository.',
    confirmLabel: 'Continue',
    onConfirm: () =>
      openDialog({
        kind: 'confirm',
        title: 'Confirm garbage collection',
        message: 'Unreachable objects (dropped stashes, and commits left behind by a reset or amend that are outside every branch and the reflog) will be permanently removed. This cannot be undone.',
        confirmLabel: 'Run gc',
        danger: true,
        onConfirm: async () => {
          try {
            await invoke('git.gc', repo.path, false);
            showToast({ kind: 'success', title: 'Garbage collection complete' });
          } catch (err) {
            showError('Garbage collection failed', err);
          } finally {
            onDone?.();
          }
        },
      }),
  });
}

/** `onDone` is called after a successful run, so the Housekeeping card can reload its numbers. */
export function confirmExpireReflog(onDone?: () => void): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  openDialog({
    kind: 'confirm',
    title: 'Expire the reflog?',
    message: 'The reflog is what lets GitGood and git recover commits after a reset, an amend or a deleted branch. Expiring it now removes that safety net for anything not reachable from a branch or tag.',
    confirmLabel: 'Continue',
    danger: true,
    onConfirm: () =>
      openDialog({
        kind: 'confirm',
        title: 'Confirm reflog expiry',
        message: 'This cannot be undone: any commit that is only reachable through the reflog will be gone the next time git garbage-collects.',
        confirmLabel: 'Expire reflog',
        danger: true,
        onConfirm: async () => {
          try {
            await invoke('git.reflog.expire', repo.path);
            showToast({ kind: 'success', title: 'Reflog expired' });
          } catch (err) {
            showError('Could not expire the reflog', err);
          } finally {
            onDone?.();
          }
        },
      }),
  });
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/** Exposed on window.__gitgood.actions so smoke tests and screenshots can drive the banner/About dialog without a real release feed. */
export function setUpdateState(state: UpdateState): void {
  store.set({ updateState: state });
}

/** Help → Check for updates… / About dialog's Check now: always runs, and (unlike the silent launch/timer checks) surfaces a network error. */
export async function checkForUpdates(): Promise<void> {
  const state = await invoke('app.update.check');
  if (state.status === 'up-to-date') showToast({ kind: 'success', title: "You're up to date" });
  else if (state.status === 'error') showToast({ kind: 'error', title: 'Could not check for updates', message: state.message, action: state.manualUrl ? { label: 'Download manually', onClick: () => void openExternal(state.manualUrl!) } : undefined }, 10000);
  else if (state.status === 'disabled') showToast({ kind: 'info', title: state.reason, action: state.manualUrl ? { label: 'Open releases page', onClick: () => void openExternal(state.manualUrl!) } : undefined });
}

export async function downloadUpdate(): Promise<void> {
  try {
    await invoke('app.update.download');
  } catch (err) {
    showError('Could not download the update', err);
  }
}

/** Restart to update: never resolves on success (the app quits first), so a rejection here always means it was refused (e.g. an operation or AI task in progress). */
export async function installUpdate(): Promise<void> {
  try {
    await invoke('app.update.install');
  } catch (err) {
    showError('Could not install the update', err);
  }
}

export async function dismissUpdate(version: string): Promise<void> {
  await invoke('app.update.dismiss', version);
}

export function openUpdateNotes(): void {
  const s = store.get().updateState;
  if (s.status !== 'available' && s.status !== 'downloading' && s.status !== 'ready') return;
  openDialog({ kind: 'update-notes', version: s.version, notes: s.notes ?? 'No release notes were provided for this version.', url: s.url });
}
