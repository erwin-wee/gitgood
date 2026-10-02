import type { RepositoryInfo, RepositoryScanResult, RepositoryStatus } from '@shared/types';
import { errorInfo, errorMessage, invoke } from '../../api';
import { closeAllDialogs, initialChanges, initialDiff, initialErrorExplain, initialExplain, initialHistory, initialNlPalette, initialPrecommitReview, initialReview, initialStashesView, initialTriage, NO_CONFLICT_EXAMPLES, openDialog, showToast, store } from '../store';
import { showError } from './core';
import { refreshBranches, refreshConflictExamples, refreshRemotes, refreshStashes } from './conflicts';
import { loadDiff, loadHistory } from './view';
import { loadCurrentPullRequest } from './github';

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export async function openRepository(repo: RepositoryInfo): Promise<void> {
  if (repo.missing) {
    showError('Repository not found', new Error(`The folder "${repo.path}" no longer exists. Remove the repository from the list or restore the folder.`));
    return;
  }
  const previous = store.get().currentRepo;
  if (previous && previous.path !== repo.path) void invoke('repo.close', previous.path);
  store.set({
    currentRepo: repo,
    status: null,
    branches: [],
    stashes: [],
    tags: [],
    remotes: [],
    changes: initialChanges,
    history: initialHistory,
    stashesView: initialStashesView,
    diff: initialDiff,
    review: initialReview,
    precommitReview: initialPrecommitReview,
    // All three outlive a repository switch otherwise: the explain panel stays
    // open over the new repo's diff, and the palette keeps the previous repo's
    // plan and history with its steps still runnable. `width` is a persisted UI
    // preference, not repo state, so it is carried across.
    explain: { ...initialExplain, width: store.get().explain.width },
    errorExplain: initialErrorExplain,
    nlPalette: initialNlPalette,
    prs: { list: [], loading: false, current: null, loadedAt: 0, error: null },
    triage: initialTriage,
    popover: null,
    lastSuccessfulMerge: null,
  });
  document.title = `${repo.alias ?? repo.name} — GitGood`;
  try {
    const opened = await invoke('repo.open', repo.path);
    store.set((s) => ({ currentRepo: { ...(s.currentRepo ?? opened), github: opened.github, aiConfigOff: opened.aiConfigOff }, repos: s.repos.map((r) => (r.id === opened.id ? { ...r, github: opened.github, lastOpened: Date.now() } : r)) }));
  } catch (err) {
    showError('Could not open repository', err);
    return;
  }
  await refreshAll();
  await loadHistory(true);
  void loadCurrentPullRequest();
}

export async function addLocalRepository(path: string): Promise<void> {
  try {
    const repo = await invoke('repos.add', path);
    closeAllDialogs();
    await openRepository(repo);
  } catch (err) {
    showError('Could not add repository', err);
  }
}

/** Opens a folder dropped on the window or passed on the command line: a repository is added and opened; anything else goes to the Add dialog, which explains the problem and offers to create a repository. */
export async function openFolderAsRepository({ path }: { path: string }): Promise<void> {
  if (await invoke('app.isRepository', path).catch(() => false)) await addLocalRepository(path);
  else openDialog({ kind: 'add-repo', path });
}

/** Desktop app only: shows `repo` in another window, which has its own open repository, selection and dialogs. */
export async function openRepositoryInNewWindow(repo: RepositoryInfo): Promise<void> {
  try {
    await invoke('app.newWindow', repo.id);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open a new window', message: errorMessage(err) });
  }
}

/** One sentence for a finished watched-folder scan, for the toast and the Options summary. */
export function describeScanResult(result: RepositoryScanResult): string {
  if (result.alreadyRunning) return 'A scan is already running.';
  // A scan that added nothing says so outright, whatever else it did: "12
  // already known" on its own reads as though something was found.
  const parts: string[] = [result.added ? `${result.added} ${result.added === 1 ? 'repository' : 'repositories'} added` : 'No new repositories found'];
  if (result.dropped) parts.push(`${result.dropped} removed (no longer on disk)`);
  if (result.skipped) parts.push(`${result.skipped} already known or excluded`);
  if (result.failed) parts.push(`${result.failed} could not be added`);
  if (result.unreadable) parts.push(`${result.unreadable} ${result.unreadable === 1 ? 'folder' : 'folders'} could not be read`);
  const summary = parts.join(' · ');
  return result.cancelled ? `Scan cancelled — ${summary.charAt(0).toLowerCase()}${summary.slice(1)}` : summary;
}

/** Scans every watched folder from the UI (menu, Options) and reports the outcome. */
export async function scanWatchedFolders(): Promise<void> {
  try {
    const result = await invoke('repos.scanWatchedFolders');
    store.set({ repos: await invoke('repos.list') });
    showToast({
      kind: result.unreadable && !result.added ? 'warning' : 'info',
      title: result.cancelled ? 'Watched folder scan cancelled' : 'Watched folders scanned',
      message: describeScanResult(result),
    });
  } catch (err) {
    showError('Could not scan watched folders', err);
  }
}

export async function removeRepository(repo: RepositoryInfo, moveToTrash: boolean): Promise<void> {
  try {
    await invoke('repos.remove', repo.id, moveToTrash);
    const list = await invoke('repos.list');
    store.set({ repos: list });
    const current = store.get().currentRepo;
    // Removing a main repository also drops its worktrees from the list; if one of them was open, switch away too.
    if (current && (current.id === repo.id || current.worktreeOf === repo.id)) {
      const next = list.filter((r) => !r.missing).sort((a, b) => b.lastOpened - a.lastOpened)[0];
      if (next) await openRepository(next);
      else {
        store.set({ currentRepo: null, status: null, branches: [], changes: initialChanges, history: initialHistory, stashesView: initialStashesView, diff: initialDiff });
        document.title = 'GitGood';
      }
    }
  } catch (err) {
    showError('Could not remove repository', err);
  }
}

export async function refreshAll(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await Promise.all([refreshStatus(), refreshBranches(), refreshStashes(), refreshRemotes(), refreshSubmodulesAndLfs()]);
}

/** Refreshes the submodule list and LFS status, which drive the post-clone banner, the LFS install banner and both dialogs. */
export async function refreshSubmodulesAndLfs(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const [submodules, lfsStatus] = await Promise.all([invoke('repo.submodules', repo.path), invoke('repo.lfs.status', repo.path)]);
    if (store.get().currentRepo?.path !== repo.path) return;
    const hadUninitialized = store.get().submodules.some((s) => s.state === 'uninitialized');
    const hasUninitialized = submodules.some((s) => s.state === 'uninitialized');
    store.set({ submodules, lfsStatus, submoduleBannerDismissed: hasUninitialized && hadUninitialized ? store.get().submoduleBannerDismissed : false });
  } catch {
    /* best-effort; the banners and dialogs simply show nothing until the next refresh */
  }
}

// ---------------------------------------------------------------------------
// Submodules
// ---------------------------------------------------------------------------

export async function initializeAndUpdateAllSubmodules(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.submodule.update', repo.path, null, true);
    showToast({ kind: 'success', title: 'Submodules initialized and updated' });
  } catch (err) {
    showError('Could not initialize submodules', err);
  } finally {
    await refreshSubmodulesAndLfs();
  }
}

export async function updateSubmodule(path: string, init: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.submodule.update', repo.path, [path], init);
    showToast({ kind: 'success', title: `Updated ${path}` });
  } catch (err) {
    showError(`Could not update ${path}`, err);
  } finally {
    await refreshSubmodulesAndLfs();
    await refreshStatus();
  }
}

/** "Update to recorded commit" from the diff pane's submodule summary. */
export async function updateSubmoduleToRecorded(path: string): Promise<void> {
  await updateSubmodule(path, false);
}

export async function syncSubmoduleUrls(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.submodule.sync', repo.path);
    showToast({ kind: 'success', title: 'Submodule URLs synced' });
  } catch (err) {
    showError('Could not sync submodule URLs', err);
  } finally {
    await refreshSubmodulesAndLfs();
  }
}

export async function openSubmoduleAsRepository(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const info = await invoke('repo.submodule.open', repo.path, path);
    const list = await invoke('repos.list');
    store.set({ repos: list });
    closeAllDialogs();
    await openRepository(list.find((r) => r.id === info.id) ?? info);
  } catch (err) {
    showError(`Could not open ${path} as a repository`, err);
  }
}

// ---------------------------------------------------------------------------
// Git LFS
// ---------------------------------------------------------------------------

export async function installLfsHooks(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.lfs.install', repo.path);
    showToast({ kind: 'success', title: 'Git LFS hooks installed' });
  } catch (err) {
    showError('Could not install Git LFS hooks', err);
  } finally {
    await refreshSubmodulesAndLfs();
  }
}

export async function setLfsTracking(pattern: string, track: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo || !pattern.trim()) return;
  try {
    await invoke('git.lfs.track', repo.path, pattern.trim(), track);
    showToast({ kind: 'success', title: track ? `Now tracking ${pattern}` : `Stopped tracking ${pattern}` });
  } catch (err) {
    showError(track ? `Could not track ${pattern}` : `Could not untrack ${pattern}`, err);
  } finally {
    await refreshSubmodulesAndLfs();
    await refreshStatus();
  }
}

export async function fetchLfsObjects(mode: 'fetch-all' | 'pull', paths: string[] | null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.lfs.fetch', repo.path, mode, paths);
    showToast({ kind: 'success', title: mode === 'fetch-all' ? 'Fetched LFS objects' : 'Pulled LFS objects' });
  } catch (err) {
    showError('Could not fetch LFS objects', err);
  } finally {
    await refreshSubmodulesAndLfs();
  }
}

/** "Download" on a missing LFS object in the diff pane: pulls just that path, then reloads the diff. */
export async function downloadLfsObject(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.lfs.fetch', repo.path, 'pull', [path]);
    await loadDiff(true);
  } catch (err) {
    showError(`Could not download ${path}`, err);
  }
}

export async function pruneLfsObjects(): Promise<{ objects: number; bytes: number } | null> {
  const repo = store.get().currentRepo;
  if (!repo) return null;
  try {
    const result = await invoke('git.lfs.prune', repo.path, false);
    showToast({ kind: 'success', title: `Pruned ${result.objects} object${result.objects === 1 ? '' : 's'}` });
    return result;
  } catch (err) {
    showError('Could not prune Git LFS objects', err);
    return null;
  } finally {
    await refreshSubmodulesAndLfs();
  }
}

let statusInFlight: Promise<void> | null = null;
export async function refreshStatus(): Promise<void> {
  if (statusInFlight) return statusInFlight;
  const repo = store.get().currentRepo;
  if (!repo) return;
  statusInFlight = (async () => {
    store.set({ statusLoading: true });
    try {
      const status = await invoke('repo.status', repo.path);
      if (store.get().currentRepo?.path !== repo.path) return;
      applyStatus(status);
    } catch (err) {
      const info = errorInfo(err);
      if (info.code === 'not-a-repository' || info.code === 'tool-missing') {
        store.set({ status: null });
      } else {
        showToast({ kind: 'error', title: 'Could not read repository status', message: info.message });
      }
    } finally {
      store.set({ statusLoading: false });
      statusInFlight = null;
    }
  })();
  return statusInFlight;
}

function applyStatus(status: RepositoryStatus): void {
  const s = store.get();
  const paths = new Set(status.files.map((f) => f.path));
  const changes = { ...s.changes };
  changes.selectedPaths = changes.selectedPaths.filter((p) => paths.has(p));
  changes.excluded = changes.excluded.filter((p) => paths.has(p));
  changes.partial = Object.fromEntries(Object.entries(changes.partial).filter(([p]) => paths.has(p)));
  if (!changes.selectedPaths.length && status.files.length) changes.selectedPaths = [status.files[0].path];
  const previousConflicts = s.status?.hasConflicts ?? false;
  store.set({ status, changes });
  if (store.get().view === 'changes') void loadDiff();
  if (previousConflicts && !status.hasConflicts && status.operation.kind === 'none' && s.status?.operation.kind === 'merge') {
    store.set({ lastSuccessfulMerge: { branch: s.status.operation.targetName ?? 'branch', at: Date.now() } });
  }
  // Guided examples, confidence tints and the check banner only make sense while an operation is
  // in progress; once it ends (completed or aborted) they are discarded, matching the resolver's
  // own in-memory example lifetime (cleared when getStatus reports operation.kind === 'none').
  if (status.operation.kind === 'none') {
    if (Object.keys(s.conflictResolutions).length || Object.keys(s.conflictOriginals).length || s.conflictExamples.length || s.checkBanner) {
      store.set({ conflictResolutions: {}, conflictSnapshots: {}, conflictBlockRanges: {}, conflictOriginals: {}, conflictExamples: NO_CONFLICT_EXAMPLES, checkBanner: null });
    }
  } else if (s.currentRepo) {
    void refreshConflictExamples(s.currentRepo.path);
  }
}
