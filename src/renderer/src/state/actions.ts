import type { AddWorktreeOptions, BlameHunk, BlameResult, Branch, BranchDeleteResult, Commit, CommitOptions, ErrorFix, ExplainSource, ExplainTarget, FileDiff, GitErrorInfo, HistoryQuery, PrTriage, PullRequest, RepoWork, RepositoryInfo, RepositoryScanResult, RepositoryStatus, Stash, StaleBranch, TriageState, UncommittedChangesStrategy, WorkingFile, ConflictResolutionResult, AppSettings, UpdateState, Worktree } from '@shared/types';
import { EMPTY_HISTORY_QUERY, EXPLAIN_FOLLOWUP_LIMIT, ZERO_SHA } from '@shared/types';
import type { OperationOutcome } from '@shared/ipc';
import { buildFileViewDiff } from '@shared/diff/parse';
import { buildStagePatch } from '@shared/diff/patch';
import { checkRegexBrackets, explanationToMarkdown, extractWorktreePathFromError, formatHistoryQuery, isEmptyHistoryQuery, issueBranchSlug, parseHistoryQuery } from '@shared/util';
import { ApiError, errorInfo, errorMessage, invoke, on } from '../api';
import { closeAllDialogs, closeDialog, initialChanges, initialDiff, initialErrorExplain, initialExplain, initialHistory, initialNlPalette, initialPrecommitReview, initialReview, initialStashesView, initialTriage, NO_CONFLICT_EXAMPLES, openDialog, patchChanges, patchDiff, patchErrorExplain, patchExplain, patchHistory, patchNlPalette, patchStashesView, patchTriage, saveExplainPanelWidth, showToast, store, type DialogState, type View } from './store';
import { handleReviewProgress, reviewBranch, reviewCurrentPullRequest } from './review';
import { handlePrecommitReviewProgress, refreshPrecommitStaleness, runPrecommitReviewForGate, syncPrecommitReviewSelection } from './precommitReview';
import { handleRebaseProgress, tidyBranch } from './rebase';
import { handleSplitProgress, openSplitDialog } from './split';
import { initInbox, loadInboxState, openInboxItemById, toggleInboxPanel } from './inbox';
import { openCommandPalette } from './nlPalette';
import { handleProtocolReviewRerun } from './agentHandoff';

export * from './review';
export * from './precommitReview';
export * from './split';
export * from './rebase';
export * from './inbox';
export * from './nlPalette';
export * from './agentHandoff';

const HISTORY_PAGE = 100;

// ---------------------------------------------------------------------------
// Bootstrap & events
// ---------------------------------------------------------------------------

function applyTheme(settings: AppSettings | null, systemDark: boolean): void {
  const theme = settings?.theme ?? 'system';
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  store.set({ dark });
}

let bootstrapped = false;

export async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  const [settings, tools, repos, updateState] = await Promise.all([invoke('app.settings.get'), invoke('app.tools', false), invoke('repos.list'), invoke('app.update.state')]);
  store.set({ settings, tools, repos, updateState });
  applyTheme(settings, store.get().dark);
  document.documentElement.style.setProperty('--diff-font-size', `${settings.diffFontSize}px`);

  on('settings.changed', (s) => {
    store.set({ settings: s });
    applyTheme(s, store.get().dark);
    document.documentElement.style.setProperty('--diff-font-size', `${s.diffFontSize}px`);
  });
  on('theme.changed', ({ dark }) => {
    store.set({ dark });
    applyTheme(store.get().settings, dark);
  });
  on('tools.changed', (t) => {
    const hadGit = store.get().tools?.git.installed ?? false;
    const hadAccount = !!store.get().tools?.ghAccount;
    store.set({ tools: t });
    if (t.git.installed && !hadGit && store.get().currentRepo && !store.get().status) {
      void refreshAll().then(() => loadHistory(true));
    }
    if (t.ghAccount && !hadAccount) void loadInboxState();
  });
  on('repos.changed', (list) => {
    const current = store.get().currentRepo;
    store.set({ repos: list, currentRepo: current ? list.find((r) => r.id === current.id) ?? current : null });
  });
  on('progress', (p) => {
    store.set((s) => {
      const next = { ...s.progress };
      if (p.done) delete next[p.id];
      else next[p.id] = p;
      return { progress: next };
    });
  });
  on('repo.changed', ({ repoPath, reason }) => {
    const repo = store.get().currentRepo;
    if (!repo || repo.path !== repoPath) return;
    void handleRepoChanged(reason);
  });
  on('menu.action', ({ action, args }) => {
    if (action === 'protocol-open') void handleProtocolOpen(args as { url: string; branch: string | null; filepath: string | null });
    else if (action === 'protocol-review-rerun') void handleProtocolReviewRerun(args as { repoPath: string });
    else void handleMenuAction(action, args);
  });
  on('gh.auth.code', ({ code, url }) => store.set((s) => ({ login: { ...s.login, code, url } })));
  on('gh.auth.finished', ({ ok, error }) => {
    store.set((s) => ({ login: { ...s.login, inProgress: false, error: ok ? null : error } }));
    if (ok) {
      showToast({ kind: 'success', title: 'Signed in to GitHub' });
      void refreshTools();
    }
  });
  on('ai.progress', (e) => {
    store.set((s) => ({ ai: { ...s.ai, [e.path]: e } }));
    if (e.phase === 'done' || e.phase === 'error') {
      setTimeout(() => store.set((s) => {
        const next = { ...s.ai };
        if (next[e.path]?.phase === e.phase) delete next[e.path];
        return { ai: next };
      }), 4000);
    }
  });
  on('ai.review.progress', (e) => (store.get().precommitReview.running ? handlePrecommitReviewProgress(e) : handleReviewProgress(e)));
  on('ai.nl.progress', (e) => {
    if (store.get().currentRepo?.path !== e.repoPath || e.phase === 'awaiting-confirmation') return;
    const phase = e.phase;
    const stepId = e.stepId;
    patchNlPalette((p) => ({ stepPhase: { ...p.stepPhase, [stepId]: phase } }));
  });
  on('ai.split.progress', handleSplitProgress);
  on('ai.rebase.progress', handleRebaseProgress);
  on('ai.triage.progress', (e) => {
    if (store.get().currentRepo?.path !== e.repoPath) return;
    patchTriage({ progress: { done: e.done, total: e.total } });
  });
  on('app.update.changed', (state) => store.set({ updateState: state }));
  on('window.focus', ({ focused }) => {
    store.set({ focused });
    if (focused && store.get().currentRepo) void refreshStatus();
  });
  initInbox();

  setInterval(() => void pollPullRequestNotifications(), 3 * 60_000);

  const candidates = repos.filter((r) => !r.missing).sort((a, b) => b.lastOpened - a.lastOpened);
  if (candidates.length) await openRepository(candidates[0]);

  if (tools.ghAccount) void loadInboxState();
  void invoke('app.tools', true).then((t) => store.set({ tools: t }));
}

/** Handles "Open with GitHub Desktop"-style links: open the repo if known, otherwise offer to clone it. */
async function handleProtocolOpen(target: { url: string; branch: string | null; filepath: string | null }): Promise<void> {
  const normalized = target.url.replace(/\.git$/i, '').toLowerCase();
  const repos = store.get().repos;
  const match = repos.find((r) => r.github && r.github.url.toLowerCase() === normalized && !r.missing);
  if (!match) {
    openDialog({ kind: 'clone', url: target.url });
    return;
  }
  await openRepository(match);
  if (target.branch) {
    const branch = store.get().branches.find((b) => b.kind === 'local' && b.name === target.branch) ?? store.get().branches.find((b) => b.kind === 'remote' && b.name === `origin/${target.branch}`);
    if (branch && !branch.isCurrent) await checkoutBranch(branch);
    else if (!branch) showToast({ kind: 'info', title: `Branch ${target.branch} not found`, message: 'Fetch to see new branches from GitHub.', action: { label: 'Fetch', onClick: () => void fetchRemote() } });
  }
  if (target.filepath) {
    const file = store.get().status?.files.find((f) => f.path === target.filepath);
    if (file) selectWorkingFile(file.path);
  }
}

async function pollPullRequestNotifications(): Promise<void> {
  const s = store.get();
  if (!s.currentRepo?.github || !s.tools?.ghAccount || !s.settings) return;
  const before = s.prs.current;
  await loadCurrentPullRequest(true);
  const after = store.get().prs.current;
  if (!before || !after || before.number !== after.number) return;
  if (s.settings.notifyPullRequestChecks && before.checks.state !== 'failure' && after.checks.state === 'failure') {
    void invoke('app.notify', `Checks failed on pull request #${after.number}`, after.title);
    showToast({ kind: 'error', title: `Checks failed on #${after.number}`, message: after.title, action: { label: 'View', onClick: () => openDialog({ kind: 'pr-details', pr: after }) } }, 15000);
  }
  if (s.settings.notifyPullRequestReviews && before.reviewDecision !== after.reviewDecision && after.reviewDecision) {
    const label = after.reviewDecision.toLowerCase().replace(/_/g, ' ');
    void invoke('app.notify', `Pull request #${after.number}: ${label}`, after.title);
    showToast({ kind: after.reviewDecision === 'APPROVED' ? 'success' : 'info', title: `Pull request #${after.number} ${label}`, message: after.title, action: { label: 'View', onClick: () => openDialog({ kind: 'pr-details', pr: after }) } }, 15000);
  }
}

export async function refreshTools(): Promise<void> {
  const tools = await invoke('app.tools', true);
  store.set({ tools });
}

/** Called after saving signing config from Options → Git, so the commit form's signing indicator re-fetches immediately without needing a repo switch. */
export function bumpSigningConfigVersion(): void {
  store.set((s) => ({ signingConfigVersion: s.signingConfigVersion + 1 }));
}

/** Called after a settings-sync action completes, so any mounted sync card re-fetches status — needed because enable/download/disconnect run behind a confirm dialog, which remounts the card mid-action (see SettingsSyncCard). */
export function bumpSettingsSyncVersion(): void {
  store.set((s) => ({ settingsSyncVersion: s.settingsSyncVersion + 1 }));
}

let repoChangeTimer: ReturnType<typeof setTimeout> | null = null;
async function handleRepoChanged(reason: 'worktree' | 'refs' | 'both'): Promise<void> {
  if (repoChangeTimer) clearTimeout(repoChangeTimer);
  repoChangeTimer = setTimeout(async () => {
    repoChangeTimer = null;
    clearBlameCache();
    await refreshStatus();
    if (reason !== 'worktree') {
      await Promise.all([refreshBranches(), refreshStashes()]);
      if (store.get().view === 'history') await loadHistory(true);
    }
    await loadDiff(true);
    if (store.get().precommitReview.run) void refreshPrecommitStaleness();
    const repo = store.get().currentRepo;
    if (repo && reason !== 'refs') void pruneStaleConflictTints(repo.path);
  }, 150);
}

// ---------------------------------------------------------------------------
// Errors & operations
// ---------------------------------------------------------------------------

export function showError(title: string, err: unknown, retry?: () => void): void {
  const info = errorInfo(err);
  if (info.code === 'cancelled') return;
  if (info.code === 'gh-not-authenticated') {
    openDialog({ kind: 'sign-in' });
    return;
  }
  if (info.code === 'ai-not-configured') {
    showToast({ kind: 'warning', title: 'AI is not configured', message: info.message, action: { label: 'Open AI settings', onClick: () => openDialog({ kind: 'settings', tab: 'ai' }) } }, 10000);
    return;
  }
  if (info.code === 'stash-missing') {
    showToast({ kind: 'warning', title: 'Stash no longer exists', message: 'The stash list has been refreshed.' });
    void refreshStashes();
    return;
  }
  openDialog({ kind: 'error', title, error: info, retry });
}

/** Runs a long git operation, surfacing it in the toolbar and reporting errors. */
export async function runOperation<T>(label: string, fn: () => Promise<T>, opts: { silent?: boolean; refresh?: boolean } = {}): Promise<T | undefined> {
  store.set({ operation: label });
  try {
    const result = await fn();
    return result;
  } catch (err) {
    if (!opts.silent) {
      const info = errorInfo(err);
      if ((info.code === 'signing-failed' || info.code === 'signing-key-missing') && await leavesRebaseInProgress()) {
        const repo = store.get().currentRepo;
        if (repo) {
          openDialog({
            kind: 'signing-failed',
            error: info,
            onRetry: () => void runOperation(label, () => invoke('git.rebase.continue', repo.path)),
            onUnsigned: () => void runOperation(label, () => invoke('git.rebase.continue', repo.path, true)),
          });
        } else {
          showError(`${label} failed`, err);
        }
      } else {
        showError(`${label} failed`, err);
      }
    }
    return undefined;
  } finally {
    store.set({ operation: null });
    if (opts.refresh !== false) void refreshAll();
  }
}

/** Squash/reword/drop/reorder/rebase all rewrite history via `git rebase [-i]`; when one of them fails to sign a commit, git pauses mid-rebase (like a conflict) rather than aborting (see runInteractiveRebase). Re-checks status so the signing-failed dialog is only offered while that pause is real. */
async function leavesRebaseInProgress(): Promise<boolean> {
  await refreshStatus();
  return store.get().status?.operation.kind === 'rebase';
}

function reportOutcome(outcome: OperationOutcome | undefined, verb: string): void {
  if (!outcome) return;
  if (outcome.status === 'conflicts') {
    void refreshAll().then(() => openDialog({ kind: 'conflicts' }));
  } else if (outcome.status === 'up-to-date') {
    showToast({ kind: 'info', title: 'Already up to date' });
  } else if (outcome.status === 'complete') {
    showToast({ kind: 'success', title: `${verb} complete` });
  }
}

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
    store.set((s) => ({ currentRepo: { ...(s.currentRepo ?? opened), github: opened.github }, repos: s.repos.map((r) => (r.id === opened.id ? { ...r, github: opened.github, lastOpened: Date.now() } : r)) }));
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

// ---------------------------------------------------------------------------
// Conflict resolution: confidence tints, examples and post-resolution checks
// ---------------------------------------------------------------------------

/** Records a resolution's per-block confidence/ranges for the diff pane's tint layer and the conflicts dialog, and shows/updates the check-failed banner. `retried` marks the banner as having already had its one "Ask AI to fix" retry. */
async function recordConflictResolution(repoPath: string, result: ConflictResolutionResult, retried = false): Promise<void> {
  if (!result.ok) return;
  let snapshot: string | null = null;
  try {
    snapshot = await invoke('repo.readFile', repoPath, result.path);
  } catch {
    snapshot = null;
  }
  store.set((s) => ({
    conflictResolutions: { ...s.conflictResolutions, [result.path]: result },
    conflictSnapshots: snapshot !== null ? { ...s.conflictSnapshots, [result.path]: snapshot } : s.conflictSnapshots,
    conflictBlockRanges: { ...s.conflictBlockRanges, [result.path]: result.blocks.map((b) => ({ id: b.id, ...b.range })) },
  }));
  if (result.check && !result.check.ok) {
    store.set({ checkBanner: { path: result.path, result: result.check, retried, original: result.original ?? '' } });
  } else if (store.get().checkBanner?.path === result.path) {
    store.set({ checkBanner: null });
  }
}

export async function refreshConflictExamples(repoPath: string): Promise<void> {
  try {
    const examples = await invoke('ai.resolve.examples', repoPath);
    store.set({ conflictExamples: examples.length ? examples : NO_CONFLICT_EXAMPLES });
  } catch {
    /* ignore */
  }
}

/** Re-checks every path with an active confidence tint against what is actually on disk, dropping any whose content no longer matches the snapshot taken right after it was resolved (see the "Tints cleared on external edit" scenario). */
async function pruneStaleConflictTints(repoPath: string): Promise<void> {
  const tracked = Object.keys(store.get().conflictResolutions);
  if (!tracked.length) return;
  await Promise.all(
    tracked.map(async (path) => {
      const expected = store.get().conflictSnapshots[path];
      if (expected === undefined) return;
      let actual: string | null;
      try {
        actual = await invoke('repo.readFile', repoPath, path);
      } catch {
        actual = null;
      }
      if (actual !== expected) {
        store.set((s) => {
          const conflictResolutions = { ...s.conflictResolutions };
          delete conflictResolutions[path];
          const conflictSnapshots = { ...s.conflictSnapshots };
          delete conflictSnapshots[path];
          const conflictBlockRanges = { ...s.conflictBlockRanges };
          delete conflictBlockRanges[path];
          return { conflictResolutions, conflictSnapshots, conflictBlockRanges, checkBanner: s.checkBanner?.path === path ? null : s.checkBanner };
        });
      }
    }),
  );
}

/** Captures the pre-resolution conflicted content the first time a path is seen as conflicted, so a later manual resolution can be recorded as a worked example. A no-op once already captured (edits after the first load must not overwrite the true original). */
function captureConflictOriginal(path: string, content: string): void {
  store.set((s) => (s.conflictOriginals[path] !== undefined ? {} : { conflictOriginals: { ...s.conflictOriginals, [path]: content } }));
}

/** Shows the one-time trust confirmation for a repository's `.gitgood/config.json` check command, when the setting allows repo commands and the repository has never been asked. Resolves once the user has answered (either way); the caller proceeds with resolving regardless — declining only disables the repo *check*, not AI resolution. */
async function ensureCheckTrustPrompted(repoPath: string): Promise<void> {
  const settings = store.get().settings;
  if (!settings?.ai.postResolveCheckFromRepo) return;
  let info: { command: string | null; trustState: 'trusted' | 'declined' | 'unknown' };
  try {
    info = await invoke('repo.checkConfig', repoPath);
  } catch {
    return;
  }
  if (!info.command || info.trustState !== 'unknown') return;
  const command = info.command;
  await new Promise<void>((resolvePromise) => {
    openDialog({
      kind: 'trust-repo-check',
      repoPath,
      command,
      onDecision: (accept) => {
        closeDialog();
        void invoke('repo.trustConfig', repoPath, accept).finally(resolvePromise);
      },
    });
  });
}

export function dismissCheckBanner(): void {
  store.set({ checkBanner: null });
}

/** The check-failed banner's single allowed retry: re-resolves the file with the failing check's command/output tail fed back to the model. */
export async function retryResolutionWithCheckOutput(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  const banner = store.get().checkBanner;
  if (!repo || !banner || banner.path !== path) return;
  store.set({ aiBusy: true });
  try {
    const result = await invoke('ai.resolve', repo.path, path, { command: banner.result.command, tail: banner.result.outputTail, original: banner.original });
    handleResolution(result);
    await recordConflictResolution(repo.path, result, true);
  } catch (err) {
    showError('AI resolution failed', err);
  } finally {
    store.set({ aiBusy: false });
    await refreshStatus();
    await loadDiff(true);
  }
}

export async function refreshBranches(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const [branches, defaultBranch] = await Promise.all([invoke('repo.branches', repo.path), invoke('repo.defaultBranch', repo.path)]);
    if (store.get().currentRepo?.path !== repo.path) return;
    store.set({ branches, defaultBranch });
  } catch {
    /* status refresh reports errors */
  }
}

export async function refreshStashes(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const stashes = await invoke('repo.stashes', repo.path);
    if (store.get().currentRepo?.path !== repo.path) return;
    store.set({ stashes });
    // The selected stash may have been dropped or applied from outside the app; fall back to an empty selection without erroring.
    const selectedSha = store.get().stashesView.selectedSha;
    if (selectedSha && !stashes.some((st) => st.sha === selectedSha)) patchStashesView({ selectedSha: null, files: [], selectedFile: null });
  } catch {
    /* ignore */
  }
}

export async function refreshRemotes(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const remotes = await invoke('repo.remotes', repo.path);
    if (store.get().currentRepo?.path === repo.path) store.set({ remotes });
  } catch {
    /* ignore */
  }
}

export async function loadTags(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    store.set({ tags: await invoke('repo.tags', repo.path) });
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not load tags', message: errorMessage(err) });
  }
}

// ---------------------------------------------------------------------------
// View & selection
// ---------------------------------------------------------------------------

export function setView(view: View): void {
  if (store.get().view === view) return;
  store.set({ view });
  if (view === 'history') {
    const h = store.get().history;
    if (!h.commits.length) void loadHistory(true);
    else if (!h.selectedShas.length) selectCommit(h.commits[0].sha);
  } else if (view === 'stashes') {
    void loadStashesView();
  }
  void loadDiff();
}

export function selectWorkingFile(path: string, opts: { toggle?: boolean; range?: boolean } = {}): void {
  const s = store.get();
  const files = s.status?.files ?? [];
  let selected: string[];
  if (opts.toggle) {
    selected = s.changes.selectedPaths.includes(path) ? s.changes.selectedPaths.filter((p) => p !== path) : [...s.changes.selectedPaths, path];
  } else if (opts.range && s.changes.selectedPaths.length) {
    const anchor = s.changes.selectedPaths[0];
    const a = files.findIndex((f) => f.path === anchor);
    const b = files.findIndex((f) => f.path === path);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    selected = [anchor, ...files.slice(lo, hi + 1).map((f) => f.path).filter((p) => p !== anchor)];
  } else {
    selected = [path];
  }
  patchChanges({ selectedPaths: selected });
  void loadDiff();
}

export function toggleIncluded(path: string): void {
  const s = store.get();
  const excluded = new Set(s.changes.excluded);
  const partial = { ...s.changes.partial };
  if (excluded.has(path)) {
    excluded.delete(path);
  } else if (partial[path]) {
    delete partial[path];
  } else {
    excluded.add(path);
  }
  patchChanges({ excluded: [...excluded], partial });
  if (s.changes.selectedPaths[0] === path) patchDiff({ selectedLines: null });
  syncPrecommitReviewSelection();
}

export function setAllIncluded(included: boolean): void {
  const s = store.get();
  patchChanges({ excluded: included ? [] : (s.status?.files ?? []).map((f) => f.path), partial: {} });
  patchDiff({ selectedLines: null });
  syncPrecommitReviewSelection();
}

export function isIncluded(path: string): 'all' | 'none' | 'partial' {
  const s = store.get();
  if (s.changes.excluded.includes(path)) return 'none';
  if (s.changes.partial[path]) return 'partial';
  return 'all';
}

/** Updates the partial selection for the currently displayed working file. */
export function setLineSelection(path: string, selected: Set<string>, total: number): void {
  const s = store.get();
  const excluded = new Set(s.changes.excluded);
  const partial = { ...s.changes.partial };
  if (selected.size === 0) {
    excluded.add(path);
    delete partial[path];
    patchDiff({ selectedLines: [] });
  } else if (selected.size >= total) {
    excluded.delete(path);
    delete partial[path];
    patchDiff({ selectedLines: null });
  } else {
    excluded.delete(path);
    partial[path] = [...selected];
    patchDiff({ selectedLines: [...selected] });
  }
  patchChanges({ excluded: [...excluded], partial });
}

export function selectCommit(sha: string, opts: { toggle?: boolean; range?: boolean } = {}): void {
  const s = store.get();
  let selected: string[];
  if (opts.toggle) {
    selected = s.history.selectedShas.includes(sha) ? s.history.selectedShas.filter((x) => x !== sha) : [...s.history.selectedShas, sha];
  } else if (opts.range && s.history.selectedShas.length) {
    const anchor = s.history.selectedShas[0];
    const a = s.history.commits.findIndex((c) => c.sha === anchor);
    const b = s.history.commits.findIndex((c) => c.sha === sha);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    selected = [anchor, ...s.history.commits.slice(lo, hi + 1).map((c) => c.sha).filter((x) => x !== anchor)];
  } else {
    selected = [sha];
  }
  patchHistory({ selectedShas: selected, details: selected.length === 1 && s.history.details?.commit.sha === selected[0] ? s.history.details : null, selectedFile: selected.length === 1 && s.history.details?.commit.sha === selected[0] ? s.history.selectedFile : null });
  if (selected.length === 1) void loadCommitDetails(selected[0]);
  else void loadDiff();
}

export function selectCommitFile(path: string): void {
  patchHistory({ selectedFile: path });
  void loadDiff();
}

export async function loadCommitDetails(sha: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  patchHistory({ detailsLoading: true, detailsError: null });
  try {
    const details = await invoke('repo.commit.details', repo.path, sha);
    const h = store.get().history;
    if (h.selectedShas[0] !== sha || h.selectedShas.length !== 1) {
      patchHistory({ detailsLoading: false });
      return;
    }
    // A content/regex search narrows the file list to files whose diff actually matched.
    let matchingFiles: string[] | null = null;
    if (h.query.content || h.query.diffRegex) {
      try {
        matchingFiles = await invoke('repo.history.matchingFiles', repo.path, sha, h.query);
      } catch {
        matchingFiles = null;
      }
      if (store.get().history.selectedShas[0] !== sha || store.get().history.selectedShas.length !== 1) {
        patchHistory({ detailsLoading: false });
        return;
      }
    }
    const visibleFiles = matchingFiles ? details.files.filter((f) => matchingFiles!.includes(f.path)) : details.files;
    // In file-history mode, prefer the tracked file's name *at this commit* (it may differ across renames).
    const pathAtCommit = h.path ? h.pathHistory?.find((e) => e.sha === sha)?.path ?? h.path : null;
    const preferred = pathAtCommit && visibleFiles.some((f) => f.path === pathAtCommit) ? pathAtCommit : null;
    const selectedFile = preferred ?? (h.selectedFile && visibleFiles.some((f) => f.path === h.selectedFile) ? h.selectedFile : visibleFiles[0]?.path ?? null);
    patchHistory({ details, detailsLoading: false, selectedFile, matchingFiles, detailsError: null });
    void loadDiff();
  } catch (err) {
    patchHistory({ detailsLoading: false, detailsError: errorMessage(err) });
    showToast({ kind: 'error', title: 'Could not load commit', message: errorMessage(err) });
  }
}

/** True while any text/structured filter is active (drag-to-reorder and the legacy "search" positional args are disabled while this is true). */
export function historyFilterActive(h = store.get().history): boolean {
  return !!h.search.trim();
}

/**
 * True while the history list is showing a subset of the branch, so
 * drag-to-reorder must be off: adjacent rows are not adjacent commits, and
 * dropping one onto the next would reorder across everything in between.
 * Broader than `historyFilterActive`, which only covers the text filter —
 * file-history mode sets `path` with an empty `search`.
 */
export function historyReorderDisabled(h = store.get().history): boolean {
  return historyFilterActive(h) || !!h.path;
}

let slowSearchTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadHistory(reset: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const h = store.get().history;
  if (h.loading && !reset) return;
  if (slowSearchTimer) clearTimeout(slowSearchTimer);
  patchHistory({ loading: true, slowSearch: false, ...(reset ? { error: null } : {}) });
  slowSearchTimer = setTimeout(() => patchHistory({ slowSearch: true }), 5000);
  try {
    const skip = reset ? 0 : h.commits.length;
    const page = await invoke('repo.history', repo.path, { ref: null, skip, limit: HISTORY_PAGE, path: h.path, search: h.freeText.trim() || null, follow: !!h.path, query: isEmptyHistoryQuery(h.query) ? null : h.query, verifySignatures: store.get().settings?.historyVerifySignatures ?? false });
    if (store.get().currentRepo?.path !== repo.path) return;
    const commits = reset ? page.commits : [...h.commits, ...page.commits];
    const stillSelected = store.get().history.selectedShas.filter((sha) => commits.some((c) => c.sha === sha));
    patchHistory({ commits, hasMore: page.hasMore, loading: false, slowSearch: false, error: null, selectedShas: stillSelected, details: stillSelected.length === 1 ? store.get().history.details : null });
    if (store.get().view === 'history' && stillSelected.length === 0 && commits.length) selectCommit(commits[0].sha);
    else if (stillSelected.length === 1 && reset) void loadCommitDetails(stillSelected[0]);
  } catch (err) {
    // A newer history request superseded this one (the main process aborts the older git run); the newer call owns the loading state.
    if (err instanceof ApiError && err.code === 'cancelled') return;
    patchHistory({ loading: false, slowSearch: false, error: errorMessage(err) });
    showToast({ kind: 'error', title: 'Could not load history', message: errorMessage(err) });
  } finally {
    if (slowSearchTimer) {
      clearTimeout(slowSearchTimer);
      slowSearchTimer = null;
    }
  }
}

/** Validates a `regex:` filter client-side (balanced brackets/parens only; git reports anything subtler once it runs). */
function validateHistoryQuery(query: HistoryQuery): string | null {
  return query.diffRegex ? checkRegexBrackets(query.diffRegex) : null;
}

/** Parses the search box text, updates the popover-synced query state, and (debounced) reloads history. Cancels the previous in-flight search (the main process aborts it once a new `repo.history` call arrives). */
export function setHistorySearch(search: string): void {
  const { query, freeText } = parseHistoryQuery(search);
  const queryError = validateHistoryQuery(query);
  patchHistory({ search, query, freeText, queryError });
  if (searchTimer) clearTimeout(searchTimer);
  if (queryError) return; // inline error only; never runs git or shows a loading state
  searchTimer = setTimeout(() => void loadHistory(true), 400);
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/** Applies the filter popover's structured query, keeping the text box in sync (round-trips through formatHistoryQuery). */
export function setHistoryQuery(query: HistoryQuery): void {
  setHistorySearch(formatHistoryQuery(query, store.get().history.freeText));
}

export function clearHistoryFilter(): void {
  setHistorySearch('');
}

/** "Search history for selection": prefills a `content:` filter from selected diff text and switches to the History tab. */
export function searchHistoryForSelection(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  setView('history');
  setHistoryQuery({ ...EMPTY_HISTORY_QUERY, content: trimmed });
  document.getElementById('history-search')?.focus();
}

// ---------------------------------------------------------------------------
// File history (History tab scoped to one file, following renames)
// ---------------------------------------------------------------------------

export function openFileHistory(path: string): void {
  patchHistory({ path, pathHistory: null, commits: [], hasMore: false, selectedShas: [], details: null, detailsLoading: false, selectedFile: null });
  setView('history');
  void loadHistory(true);
  void loadPathHistory(path);
}

export function clearFileHistory(): void {
  const h = store.get().history;
  if (!h.path) return;
  patchHistory({ path: null, pathHistory: null, commits: [], hasMore: false, selectedShas: [], details: null, detailsLoading: false, selectedFile: null });
  void loadHistory(true);
}

async function loadPathHistory(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const entries = await invoke('repo.pathHistory', repo.path, path);
    if (store.get().history.path !== path) return;
    patchHistory({ pathHistory: entries });
    const h = store.get().history;
    if (h.selectedShas.length === 1) void loadCommitDetails(h.selectedShas[0]);
  } catch {
    // Best-effort: without a rename map, file-history selection falls back to the current path.
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** path|rev of the file the blame gutter was last computed for; used to auto-turn it off when the user switches files/commits. */
let lastBlameTarget: string | null = null;
const blameCache = new Map<string, BlameResult>();

export function clearBlameCache(): void {
  blameCache.clear();
}

export async function loadDiff(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo) {
    patchDiff({ key: null, diff: null, loading: false, error: null, selectedLines: null, blame: null, blameOn: false, highlightTerm: null });
    return;
  }
  const opts = { hideWhitespace: s.settings?.diffHideWhitespace ?? false };
  let key: string | null = null;
  let fetcher: (() => Promise<FileDiff>) | null = null;
  let selectedLines: string[] | null = null;
  /** First-matching-line highlight for an active content/regex history search. */
  let highlightTerm: { text: string; regex: boolean } | null = null;
  /** Set only for views where blame is a supported entry point (Changes and History). */
  let blameTarget: { path: string; rev: string | null } | null = null;
  /** The Changes tab's selected working-tree path, if any; used to capture a conflicted file's pre-resolution content the first time it loads (see captureConflictOriginal). */
  let workingPath: string | null = null;
  if (s.review.open && s.review.run) {
    const run = s.review.run;
    const f = s.review.selectedPath;
    if (f) {
      key = `review:${run.id}:${f}`;
      const target = run.target;
      fetcher = target.kind === 'pr' ? () => invoke('gh.pr.fileDiff', repo.path, target.number, f, opts) : () => invoke('repo.diff.range', repo.path, target.baseSha, target.headSha, f, opts);
    }
  } else if (s.view === 'changes') {
    if (s.changes.selectedPaths.length === 1) {
      const path = s.changes.selectedPaths[0];
      key = `working:${path}`;
      fetcher = () => invoke('repo.diff.working', repo.path, path, opts);
      selectedLines = s.changes.excluded.includes(path) ? [] : s.changes.partial[path] ?? null;
      blameTarget = { path, rev: null };
      workingPath = path;
    }
  } else if (s.view === 'stashes') {
    const stash = s.stashes.find((st) => st.sha === s.stashesView.selectedSha);
    const f = s.stashesView.selectedFile;
    if (stash && f) {
      key = `stash:${stash.sha}:${f}`;
      // Pass the SHA (not the positional stash@{N} ref): it stays valid even if another
      // stash is pushed or dropped between selecting this row and fetching its diff.
      fetcher = () => invoke('repo.diff.stash', repo.path, stash.sha, f, opts);
    }
  } else if (s.history.selectedShas.length === 1 && s.history.selectedFile) {
    const sha = s.history.selectedShas[0];
    const f = s.history.selectedFile;
    key = `commit:${sha}:${f}`;
    fetcher = () => invoke('repo.commit.diff', repo.path, sha, f, opts);
    blameTarget = { path: f, rev: sha };
    if (s.history.query.content) highlightTerm = { text: s.history.query.content, regex: !!s.history.query.contentRegex };
    else if (s.history.query.diffRegex) highlightTerm = { text: s.history.query.diffRegex, regex: true };
  }

  const blameTargetKey = blameTarget ? `${blameTarget.path}|${blameTarget.rev ?? ''}` : null;
  if (blameTargetKey !== lastBlameTarget) {
    lastBlameTarget = blameTargetKey;
    if (store.get().diff.blameOn) patchDiff({ blameOn: false, blame: null, blameLoading: false });
  }

  if (store.get().diff.blameOn && blameTarget) {
    const { path, rev } = blameTarget;
    const ignoreWhitespace = s.settings?.blameIgnoreWhitespace ?? true;
    key = `blame:${path}:${rev ?? 'wt'}:${ignoreWhitespace}`;
    fetcher = async () => {
      const cacheKey = `${repo.path}|${key}`;
      let result = blameCache.get(cacheKey) ?? null;
      if (!result) {
        patchDiff({ blameLoading: true });
        try {
          result = await invoke('repo.blame', repo.path, path, rev, ignoreWhitespace);
          blameCache.set(cacheKey, result);
        } finally {
          patchDiff({ blameLoading: false });
        }
      }
      if (store.get().diff.key === key) patchDiff({ blame: result });
      if (result.tooLarge) return { kind: 'too-large', lineCount: result.lineCount, bytes: 0 };
      if (result.binary) return { kind: 'binary', oldBytes: null, newBytes: null };
      if (result.content === null) return { kind: 'empty', reason: 'Could not load file content for blame.' };
      return buildFileViewDiff(path, result.content);
    };
  } else if (store.get().diff.blame) {
    patchDiff({ blame: null });
  }

  if (!key || !fetcher) {
    patchDiff({ key: null, diff: null, loading: false, error: null, selectedLines: null, blame: null, highlightTerm: null });
    return;
  }
  key += `|ws=${opts.hideWhitespace}`;
  if (!force && s.diff.key === key && (s.diff.diff || s.diff.loading) && s.diff.highlightTerm?.text === highlightTerm?.text) return;
  const samePath = s.diff.key !== null && s.diff.key.split('|')[0] === key.split('|')[0];
  patchDiff({ key, loading: !samePath || !s.diff.diff, error: null, selectedLines, diff: samePath ? s.diff.diff : null, highlightTerm });
  try {
    const diff = await fetcher();
    if (store.get().diff.key !== key) return;
    patchDiff({ diff, loading: false, error: null });
    if (workingPath && diff.kind === 'conflict') captureConflictOriginal(workingPath, diff.content);
  } catch (err) {
    if (store.get().diff.key !== key) return;
    patchDiff({ diff: null, loading: false, error: errorMessage(err) });
  }
}

export function toggleBlame(): void {
  patchDiff({ blameOn: !store.get().diff.blameOn, activeBlameId: null });
  void loadDiff(true);
}

export function setActiveBlame(id: string | null): void {
  const current = store.get().diff.activeBlameId;
  patchDiff({ activeBlameId: current === id ? null : id });
}

/** Re-blames the file as of the commit before `hunk`'s commit, using the path it had back then. */
export function blameAtParent(hunk: BlameHunk): void {
  const s = store.get();
  if (!hunk.previousSha) return;
  // Pre-sync the "last blamed target" so the loadDiff() triggered by the navigation below doesn't
  // treat this as a plain file/commit switch and turn blame back off.
  lastBlameTarget = `${hunk.originalPath}|${hunk.previousSha}`;
  patchDiff({ activeBlameId: null, blameOn: true });
  if (s.view === 'history') {
    patchHistory({ selectedShas: [hunk.previousSha], selectedFile: hunk.originalPath, details: null });
    void loadCommitDetails(hunk.previousSha);
  } else {
    // Changes tab: blame stays on the working tree; there is no "commit" to move the whole view to,
    // so jump to History at the parent commit instead, which is where "blame at a commit" belongs.
    setView('history');
    selectCommit(hunk.previousSha);
    patchHistory({ selectedFile: hunk.originalPath });
  }
}

export function openCommitFromBlame(hunk: BlameHunk): void {
  if (hunk.sha === ZERO_SHA) return;
  setView('history');
  selectCommit(hunk.sha);
}

// ---------------------------------------------------------------------------
// File history actions: view a past version, restore it to the working tree.
// ---------------------------------------------------------------------------

export function openFileAtCommit(path: string, sha: string): void {
  openDialog({ kind: 'file-at-commit', path, sha });
}

export function requestRestoreFile(path: string, sha: string): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const dirty = !!store.get().status?.files.some((f) => f.path === path);
  let stashFirst = false;
  openDialog({
    kind: 'confirm',
    title: 'Restore this version?',
    message: `The working copy of "${path}" will be overwritten with its content from ${sha.slice(0, 7)}.${dirty ? ' You have uncommitted changes to this file.' : ''}`,
    confirmLabel: 'Restore',
    checkbox: dirty ? { label: 'Stash my current changes to this file first', onChange: (v) => { stashFirst = v; } } : undefined,
    onConfirm: () => restoreFileVersion(path, sha, dirty && stashFirst),
  });
}

export async function restoreFileVersion(path: string, sha: string, stashFirst: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    if (stashFirst) await invoke('git.stash.push', repo.path, `Stashed before restoring ${path}`, true, [path]);
    const result = await invoke('repo.fileAtCommit', repo.path, sha, path);
    if (result.content === null) {
      showToast({ kind: 'error', title: 'Could not restore file', message: result.binary ? 'The file is binary.' : 'The file is too large to restore this way.' });
      return;
    }
    await invoke('repo.writeFile', repo.path, path, result.content);
    showToast({ kind: 'success', title: `Restored ${path.split('/').pop()}`, message: `Reverted to its content at ${sha.slice(0, 7)}.` });
    await refreshStatus();
    if (stashFirst) await refreshStashes();
    if (store.get().view === 'changes') void loadDiff(true);
  } catch (err) {
    showError('Could not restore file', err);
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export function includedFiles(): WorkingFile[] {
  const s = store.get();
  return (s.status?.files ?? []).filter((f) => !s.changes.excluded.includes(f.path));
}

export async function commit(): Promise<void> {
  const s = store.get();
  const gateOn = s.settings?.ai.reviewBeforeCommit && s.settings.ai.provider !== 'disabled' && !s.changes.committing;
  if (gateOn) {
    const run = await runPrecommitReviewForGate();
    const live = run ? run.findings.filter((f) => !f.dismissed) : [];
    if (run && live.length) {
      openDialog({ kind: 'precommit-review-gate', run, onCommitAnyway: () => { closeDialog(); void performCommit('default'); } });
      return;
    }
  }
  await performCommit('default');
}

/** Shared by the normal commit button and the signing-failed dialog's Retry / Commit unsigned this time actions. */
async function performCommit(signOverride: 'default' | 'unsigned'): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.status) return;
  const files = includedFiles();
  if (!files.length && !s.changes.amend) return;
  const summary = s.changes.summary.trim();
  const inProgressMerge = s.status.operation.kind === 'merge';
  if (!summary && !s.changes.amend && !inProgressMerge) return;
  patchChanges({ committing: true });
  try {
    const partialPatches: Record<string, string> = {};
    for (const [path, keys] of Object.entries(s.changes.partial)) {
      if (!files.some((f) => f.path === path)) continue;
      const diff = await invoke('repo.diff.working', repo.path, path, { hideWhitespace: false });
      if (diff.kind !== 'text') continue;
      const set = new Set(keys);
      const patch = buildStagePatch({ oldPath: diff.oldPath, newPath: diff.newPath, hunks: diff.hunks }, (h, l) => set.has(`${h}:${l}`));
      if (patch) partialPatches[path] = patch;
    }
    const opts: CommitOptions = {
      summary,
      description: s.changes.description,
      coAuthors: s.changes.showCoAuthors ? s.changes.coAuthors : [],
      amend: s.changes.amend,
      files: files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])),
      partialPatches,
      signOverride,
    };
    const sha = await invoke('git.commit', repo.path, opts);
    patchChanges({ summary: '', description: '', amend: false, committing: false, partial: {}, excluded: [] });
    patchDiff({ selectedLines: null });
    showToast({ kind: 'success', title: s.changes.amend ? 'Commit amended' : `Committed ${sha.slice(0, 7)}`, message: summary || undefined, action: s.changes.amend ? undefined : { label: 'Undo', onClick: () => void undoCommit() } });
    await refreshAll();
    if (store.get().view === 'history') await loadHistory(true);
    else patchHistory({ commits: [], hasMore: false });
  } catch (err) {
    patchChanges({ committing: false });
    const info = errorInfo(err);
    if (info.code === 'signing-failed' || info.code === 'signing-key-missing') {
      openDialog({ kind: 'signing-failed', error: info, onRetry: () => void performCommit('default'), onUnsigned: () => void performCommit('unsigned') });
    } else {
      showError('Commit failed', err);
    }
  }
}

export async function undoCommit(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const status = store.get().status;
  if (status?.branch.unborn) return;
  const perform = async () => {
    try {
      const details = store.get().history.commits[0] ?? null;
      await invoke('git.undoCommit', repo.path);
      if (details) patchChanges({ summary: details.summary, description: details.body, coAuthors: details.coAuthors, showCoAuthors: details.coAuthors.length > 0 });
      await refreshAll();
      await loadHistory(true);
      setView('changes');
    } catch (err) {
      showError('Undo commit failed', err);
    }
  };
  const settings = store.get().settings;
  const commitPushed = status && status.branch.ahead === 0 && status.branch.upstream !== null;
  if (settings?.confirmUndoCommit && commitPushed) {
    openDialog({ kind: 'confirm', title: 'Undo commit?', message: 'This commit has already been pushed. Undoing it will diverge your branch from the remote and require a force push.', confirmLabel: 'Undo commit', danger: true, onConfirm: perform });
  } else {
    await perform();
  }
}

export async function setAmend(amend: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  if (amend) {
    const last = store.get().history.commits[0] ?? (await invoke('repo.history', repo.path, { ref: null, skip: 0, limit: 1, path: null, search: null, follow: false })).commits[0];
    if (last) patchChanges({ amend: true, summary: last.summary, description: last.body, coAuthors: last.coAuthors, showCoAuthors: last.coAuthors.length > 0 });
    else patchChanges({ amend: true });
  } else {
    patchChanges({ amend: false, summary: '', description: '' });
  }
}

export async function generateCommitMessage(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const files = includedFiles();
  if (!files.length) {
    showToast({ kind: 'warning', title: 'Select at least one file to describe' });
    return;
  }
  store.set({ aiCommitBusy: true });
  try {
    const msg = await invoke('ai.commitMessage', repo.path, files.map((f) => f.path));
    patchChanges({ summary: msg.summary, description: msg.description });
  } catch (err) {
    showError('Could not generate a commit message', err);
  } finally {
    store.set({ aiCommitBusy: false });
  }
}

// ---------------------------------------------------------------------------
// Sync: fetch / pull / push
// ---------------------------------------------------------------------------

export async function fetchRemote(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await runOperation('Fetch', () => invoke('git.fetch', repo.path, null));
}

export async function pull(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Pull', () => invoke('git.pull', repo.path));
  if (outcome?.status === 'conflicts') reportOutcome(outcome, 'Pull');
  else if (outcome?.status === 'complete') showToast({ kind: 'success', title: 'Pulled latest changes' });
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

async function withUncommittedChanges(targetLabel: string, perform: (strategy: UncommittedChangesStrategy) => Promise<void>): Promise<void> {
  const settings = store.get().settings;
  const strategy = settings?.uncommittedChangesStrategy ?? 'ask';
  if (!hasUncommittedChanges()) {
    await perform('move');
    return;
  }
  if (strategy === 'ask') {
    openDialog({ kind: 'uncommitted-changes', targetLabel, proceed: perform });
    return;
  }
  await perform(strategy);
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

export async function rebaseOnto(branch: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeAllDialogs();
  const outcome = await runOperation('Rebase', () => invoke('git.rebase', repo.path, branch));
  if (outcome?.status === 'complete') {
    showToast({ kind: 'success', title: `Rebased onto ${branch}` });
    await loadHistory(true);
  } else reportOutcome(outcome, 'Rebase');
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

// ---------------------------------------------------------------------------
// In-progress operations (merge / rebase / cherry-pick / revert)
// ---------------------------------------------------------------------------

export async function continueOperation(): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.status) return;
  const kind = s.status.operation.kind;
  const method = kind === 'rebase' ? 'git.rebase.continue' : kind === 'cherry-pick' ? 'git.cherryPick.continue' : kind === 'revert' ? 'git.revert.continue' : 'git.merge.continue';
  const outcome = await runOperation(`Continue ${kind}`, () => invoke(method, repo.path));
  if (outcome?.status === 'complete') {
    closeAllDialogs();
    showToast({ kind: 'success', title: `${kind === 'merge' ? 'Merge' : kind === 'rebase' ? 'Rebase' : kind === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} complete` });
    await loadHistory(true);
  } else if (outcome?.status === 'conflicts') {
    showToast({ kind: 'warning', title: 'More conflicts to resolve' });
  }
}

export async function abortOperation(): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.status) return;
  const kind = s.status.operation.kind;
  const method = kind === 'rebase' ? 'git.rebase.abort' : kind === 'cherry-pick' ? 'git.cherryPick.abort' : kind === 'revert' ? 'git.revert.abort' : 'git.merge.abort';
  openDialog({
    kind: 'confirm',
    title: `Abort ${kind}?`,
    message: `Conflict resolutions made during this ${kind} will be discarded and the branch returns to its pre-${kind} state.`,
    confirmLabel: `Abort ${kind}`,
    danger: true,
    onConfirm: async () => {
      await runOperation(`Abort ${kind}`, () => invoke(method, repo.path));
      closeAllDialogs();
      await loadHistory(true);
    },
  });
}

export async function skipRebaseCommit(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Skip commit', () => invoke('git.rebase.skip', repo.path));
  if (outcome?.status === 'complete') closeAllDialogs();
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export async function resolveWithAi(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await ensureCheckTrustPrompted(repo.path);
  store.set({ aiBusy: true });
  try {
    const result = await invoke('ai.resolve', repo.path, path);
    handleResolution(result);
    await recordConflictResolution(repo.path, result);
  } catch (err) {
    showError('AI resolution failed', err);
  } finally {
    store.set({ aiBusy: false });
    await refreshStatus();
    await loadDiff(true);
    await refreshConflictExamples(repo.path);
  }
}

export async function resolveAllWithAi(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await ensureCheckTrustPrompted(repo.path);
  store.set({ aiBusy: true });
  try {
    const results = await invoke('ai.resolveAll', repo.path);
    await Promise.all(results.map((r) => recordConflictResolution(repo.path, r)));
    reportBatchResolution(results);
  } catch (err) {
    showError('AI resolution failed', err);
  } finally {
    store.set({ aiBusy: false });
    await refreshStatus();
    await loadDiff(true);
    await refreshConflictExamples(repo.path);
  }
}

/** "Resolve remaining like `<file>`…": resolves every remaining conflicted file guided by the manual resolutions recorded so far in this operation. */
export async function resolveAllGuided(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await ensureCheckTrustPrompted(repo.path);
  store.set({ aiBusy: true });
  try {
    const results = await invoke('ai.resolveAllGuided', repo.path);
    await Promise.all(results.map((r) => recordConflictResolution(repo.path, r)));
    reportBatchResolution(results, results.find((r) => r.guidedBy.length)?.guidedBy ?? []);
  } catch (err) {
    showError('AI resolution failed', err);
  } finally {
    store.set({ aiBusy: false });
    await refreshStatus();
    await loadDiff(true);
    await refreshConflictExamples(repo.path);
  }
}

function reportBatchResolution(results: ConflictResolutionResult[], guidedBy: string[] = []): void {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (ok.length) {
    const guidedNote = guidedBy.length ? ` guided by ${guidedBy.join(', ')}` : '';
    showToast(
      {
        kind: 'success',
        title: `AI resolved ${ok.length} file${ok.length === 1 ? '' : 's'}${guidedNote}`,
        message: ok.some((r) => r.blocks.some((b) => b.confidence === 'low')) ? 'Some resolutions have low confidence; review them before committing.' : undefined,
        action: { label: 'Undo all', onClick: () => void undoResolutions(ok) },
      },
      12000,
    );
  }
  for (const f of failed) showToast({ kind: 'error', title: `Could not resolve ${f.path}`, message: f.error ?? undefined }, 10000);
}

function handleResolution(result: ConflictResolutionResult): void {
  if (!result.ok) {
    showToast({ kind: 'error', title: `Could not resolve ${result.path}`, message: result.error ?? undefined }, 10000);
    return;
  }
  const low = result.blocks.filter((b) => b.confidence === 'low');
  showToast(
    {
      kind: low.length ? 'warning' : 'success',
      title: `Resolved ${result.path}`,
      message: low.length ? `${low.length} of ${result.blocks.length} block${result.blocks.length === 1 ? '' : 's'} flagged low confidence: ${low[0].rationale}` : result.blocks.map((b) => b.rationale).filter(Boolean).slice(0, 2).join(' '),
      action: { label: 'Undo', onClick: () => void undoResolutions([result]) },
    },
    12000,
  );
}

export async function undoResolutions(results: ConflictResolutionResult[]): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  for (const r of results) {
    try {
      await invoke('git.conflict.unresolve', repo.path, r.path, r.original);
    } catch (err) {
      showToast({ kind: 'error', title: `Could not undo ${r.path}`, message: errorMessage(err) });
    }
  }
  store.set((s) => {
    const conflictResolutions = { ...s.conflictResolutions };
    const conflictSnapshots = { ...s.conflictSnapshots };
    const conflictBlockRanges = { ...s.conflictBlockRanges };
    for (const r of results) {
      delete conflictResolutions[r.path];
      delete conflictSnapshots[r.path];
      delete conflictBlockRanges[r.path];
    }
    return { conflictResolutions, conflictSnapshots, conflictBlockRanges, checkBanner: s.checkBanner && results.some((r) => r.path === s.checkBanner!.path) ? null : s.checkBanner };
  });
  await refreshStatus();
  await loadDiff(true);
}

async function undoUseSide(repoPath: string, path: string, original: string): Promise<void> {
  try {
    await invoke('git.conflict.unresolve', repoPath, path, original);
  } catch (err) {
    showToast({ kind: 'error', title: `Could not undo ${path}`, message: errorMessage(err) });
  }
  await refreshStatus();
  await loadDiff(true);
}

export async function useSide(path: string, side: 'ours' | 'theirs'): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const original = await invoke('repo.readFile', repo.path, path).catch(() => null);
  try {
    await invoke('git.conflict.useSide', repo.path, path, side);
    await refreshStatus();
    await loadDiff(true);
    showToast({ kind: 'success', title: `Took ${side} for ${path}`, action: original !== null ? { label: 'Undo', onClick: () => void undoUseSide(repo.path, path, original) } : undefined });
  } catch (err) {
    showError('Could not resolve conflict', err);
  }
}

/** Per-block "Use ours/theirs/base" from the explain-why popover: rewrites just that block from the pre-resolution snapshot, keeping the AI text for the rest. */
export async function useSideForBlock(path: string, blockId: number, side: 'ours' | 'theirs' | 'base'): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const resolution = store.get().conflictResolutions[path];
  const original = store.get().conflictOriginals[path];
  // conflictBlockRanges always covers every block, including one already manually overridden by an
  // earlier useSideForBlock call; conflictResolutions[path].blocks alone would not (it drops a block
  // once it stops being an AI suggestion), which would make a second per-block pick fail.
  const ranges = store.get().conflictBlockRanges[path] ?? resolution?.blocks.map((b) => ({ id: b.id, ...b.range }));
  if (!resolution || original === undefined || !ranges) {
    showToast({ kind: 'error', title: 'Could not apply your choice', message: 'This block’s resolution data is no longer available; resolve the file again.' });
    return;
  }
  try {
    const res = await invoke('ai.resolve.useSideForBlock', repo.path, path, original, ranges, blockId, side);
    store.set((s) => {
      const prev = s.conflictResolutions[path];
      if (!prev) return {};
      const blocks = prev.blocks
        .filter((b) => b.id !== blockId)
        .map((b) => {
          const r = res.ranges.find((x) => x.id === b.id);
          return r ? { ...b, range: { start: r.start, end: r.end } } : b;
        });
      return {
        conflictResolutions: { ...s.conflictResolutions, [path]: { ...prev, blocks } },
        conflictSnapshots: { ...s.conflictSnapshots, [path]: res.content },
        conflictBlockRanges: { ...s.conflictBlockRanges, [path]: res.ranges },
      };
    });
    closeDialog();
    await refreshStatus();
    await loadDiff(true);
  } catch (err) {
    showError('Could not apply your choice', err);
  }
}

export async function markResolved(paths: string[]): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const stored = store.get().conflictOriginals;
    const originals: Record<string, string | null> = {};
    for (const p of paths) if (stored[p] !== undefined) originals[p] = stored[p];
    await invoke('git.conflict.markResolved', repo.path, paths, originals);
    store.set((s) => {
      const conflictOriginals = { ...s.conflictOriginals };
      for (const p of paths) delete conflictOriginals[p];
      return { conflictOriginals };
    });
    await refreshStatus();
    await loadDiff(true);
    await refreshConflictExamples(repo.path);
  } catch (err) {
    showError('Could not mark as resolved', err);
  }
}

/** Writes an edited conflict file (manual per-block resolution in the diff view). `original` is the pre-edit conflicted content (with markers), when known, used to record a "Resolve remaining like …" worked example once the file is auto-staged. */
export async function writeResolvedContent(path: string, content: string, stillHasConflicts: boolean, original?: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('repo.writeFile', repo.path, path, content);
    if (!stillHasConflicts && store.get().settings?.ai.autoStageAfterResolve !== false) {
      const originals: Record<string, string | null> = original !== undefined ? { [path]: original } : {};
      await invoke('git.conflict.markResolved', repo.path, [path], originals);
      store.set((s) => {
        const conflictOriginals = { ...s.conflictOriginals };
        delete conflictOriginals[path];
        return { conflictOriginals };
      });
      await refreshConflictExamples(repo.path);
    }
    await refreshStatus();
    await loadDiff(true);
  } catch (err) {
    showError('Could not write file', err);
  }
}

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

// ---------------------------------------------------------------------------
// Pull requests & GitHub
// ---------------------------------------------------------------------------

export async function loadPullRequests(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo?.github) return;
  if (!force && Date.now() - s.prs.loadedAt < 60_000 && s.prs.list.length) return;
  if (s.prs.loading) return;
  store.set((st) => ({ prs: { ...st.prs, loading: true, error: null } }));
  try {
    const list = await invoke('gh.pr.list', repo.path, 'open');
    if (store.get().currentRepo?.path !== repo.path) return;
    store.set((st) => ({ prs: { ...st.prs, list, loading: false, loadedAt: Date.now() } }));
    await loadTriageCache();
    const settings = store.get().settings;
    if (settings && settings.ai.provider !== 'disabled' && settings.ai.triageAutoRefresh) void summarizePullRequests();
  } catch (err) {
    const info = errorInfo(err);
    store.set((st) => ({ prs: { ...st.prs, loading: false, error: info.message } }));
  }
}

// ---------------------------------------------------------------------------
// AI pull request triage (add-ai-pr-triage)
// ---------------------------------------------------------------------------

/** True when the signed-in user was explicitly asked to review, independent of any cached AI triage line (so the "waiting on you" count is accurate before Summarize has ever run). */
export function isExplicitlyWaitingOnYou(pr: PullRequest, login: string | null): boolean {
  return !!login && pr.reviewRequests.some((r) => r.toLowerCase() === login.toLowerCase());
}

/** True when a cached triage line still matches the pull request's current updatedAt. */
export function isTriageFresh(entry: PrTriage | undefined, pr: PullRequest): boolean {
  return !!entry && entry.updatedAt === pr.updatedAt;
}

/** Open pull request numbers with no fresh cached triage line (what "Summarize N pull requests" counts and requests). */
export function pendingTriageNumbers(prs: PullRequest[], cache: Record<number, PrTriage>): number[] {
  return prs.filter((pr) => pr.state === 'OPEN' && !isTriageFresh(cache[pr.number], pr)).map((pr) => pr.number);
}

/** The triage state to show for a pull request: the fresh cached line's state, or, failing that, "waiting-on-you" when the signed-in user was explicitly asked to review (a deterministic fact that needs no AI call). Null when neither applies. */
export function effectiveTriageState(pr: PullRequest, cache: Record<number, PrTriage>, login: string | null): TriageState | null {
  const entry = cache[pr.number];
  if (isTriageFresh(entry, pr)) return entry!.state;
  return isExplicitlyWaitingOnYou(pr, login) ? 'waiting-on-you' : null;
}

/** Pull requests currently classified as waiting on the signed-in user, combining fresh cached lines with the deterministic review-request check. */
export function waitingOnYouPrs(prs: PullRequest[], cache: Record<number, PrTriage>, login: string | null): PullRequest[] {
  return prs.filter((pr) => effectiveTriageState(pr, cache, login) === 'waiting-on-you');
}

export async function loadTriageCache(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo?.github) return;
  try {
    const cache = await invoke('ai.triage.get', repo.path);
    if (store.get().currentRepo?.path !== repo.path) return;
    patchTriage({ byNumber: cache, loadedAt: Date.now() });
  } catch {
    /* best effort: an empty cache just means every pull request needs summarizing */
  }
}

/** Requests triage lines for every open pull request lacking a fresh cache entry, batched and cancellable via ai.cancel (see ai.triage.progress). */
export async function summarizePullRequests(): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo?.github || s.triage.loading) return;
  const numbers = pendingTriageNumbers(s.prs.list, s.triage.byNumber);
  if (!numbers.length) return;
  patchTriage({ loading: true, progress: { done: 0, total: numbers.length } });
  try {
    const result = await invoke('ai.triage.run', repo.path, numbers);
    if (store.get().currentRepo?.path === repo.path) patchTriage({ byNumber: result, loading: false, progress: null, loadedAt: Date.now() });
    else patchTriage({ loading: false, progress: null });
  } catch (err) {
    patchTriage({ loading: false, progress: null });
    showError('Could not summarize pull requests', err);
  }
}

export function cancelTriage(): void {
  void invoke('ai.cancel');
}

export async function loadCurrentPullRequest(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  const branch = s.status?.branch.name ?? null;
  if (!repo?.github || !branch) {
    store.set((st) => ({ prs: { ...st.prs, current: null } }));
    return;
  }
  if (!force && s.prs.current && s.prs.current.headRefName === branch) return;
  try {
    const pr = await invoke('gh.pr.forBranch', repo.path, branch);
    if (store.get().currentRepo?.path === repo.path && store.get().status?.branch.name === branch) store.set((st) => ({ prs: { ...st.prs, current: pr } }));
  } catch {
    /* not signed in or offline */
  }
}

export async function checkoutPullRequest(pr: PullRequest): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await withUncommittedChanges(`#${pr.number}`, async (strategy) => {
    closeAllDialogs();
    store.set({ operation: `Checking out #${pr.number}`, popover: null });
    try {
      if (strategy === 'stash') await invoke('git.stash.push', repo.path, 'Stashed before switching branches', true, null);
      await invoke('gh.pr.checkout', repo.path, pr.number);
      await refreshAll();
      await loadHistory(true);
      store.set((st) => ({ prs: { ...st.prs, current: pr } }));
    } catch (err) {
      showError(`Could not check out pull request #${pr.number}`, err);
    } finally {
      store.set({ operation: null });
    }
  });
}

export async function openExternal(url: string): Promise<void> {
  try {
    await invoke('app.openExternal', url);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not open link', message: errorMessage(err) });
  }
}

export function viewOnGitHub(): void {
  const repo = store.get().currentRepo;
  if (repo?.github) void openExternal(repo.github.url);
  else showToast({ kind: 'info', title: 'This repository has no GitHub remote' });
}

export function compareOnGitHub(): void {
  const s = store.get();
  const repo = s.currentRepo;
  const branch = s.status?.branch.name;
  if (!repo?.github || !branch) return;
  const base = s.defaultBranch ?? 'main';
  void openExternal(`${repo.github.url}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`);
}

export function openPullRequestFlow(autoDraft = false): void {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo) return;
  if (!repo.github) {
    openDialog({ kind: 'publish' });
    return;
  }
  if (s.prs.current && s.prs.current.state === 'OPEN') {
    void openExternal(s.prs.current.url);
    return;
  }
  if (!s.status?.branch.upstream || s.status.branch.ahead > 0) {
    showToast({ kind: 'info', title: 'Publish your branch first', message: 'The branch has commits that are not on GitHub yet.', action: { label: 'Push', onClick: () => void pushWithErrorHandling() } });
    return;
  }
  openDialog({ kind: 'create-pr', autoDraft });
}

/** Opens the Create pull request dialog and starts drafting its title and body with AI (the Branch menu's "Draft Pull Request with AI…" entry). */
export function draftPullRequest(): void {
  openPullRequestFlow(true);
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

/** Opens the Release notes dialog, from the Repository menu (no `fromTag`) or a tag's History context menu ("notes since this tag"). Exposed on window.__gitgood.actions for smoke tests. */
export function openReleaseNotes(fromTag?: string): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  openDialog({ kind: 'release-notes', fromTag: fromTag ?? null });
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export function openIssuesDialog(number?: number): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  if (!repo.github) {
    showToast({ kind: 'info', title: 'This repository has no GitHub remote' });
    return;
  }
  openDialog({ kind: 'issues', number });
}

/** Appends text to the commit description, on its own line, without replacing anything already there. */
export function appendDescription(text: string): void {
  patchChanges((c) => ({ description: c.description.trim() ? `${c.description.replace(/\s+$/, '')}\n${text}` : text }));
}

/** "Create branch for issue": closes whatever dialog is open and opens a fresh New Branch dialog pre-filled with the issue's slug. */
export function createBranchForIssue(number: number, title: string): void {
  closeAllDialogs();
  openDialog({ kind: 'new-branch', initialName: issueBranchSlug(number, title) });
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export async function signIn(host = 'github.com'): Promise<void> {
  store.set({ login: { inProgress: true, code: null, url: null, error: null } });
  try {
    const result = await invoke('gh.auth.login', host);
    store.set((s) => ({ login: { ...s.login, inProgress: false, error: result.ok ? null : result.error } }));
    if (result.ok) {
      await refreshTools();
      closeDialog();
    }
  } catch (err) {
    store.set((s) => ({ login: { ...s.login, inProgress: false, error: errorMessage(err) } }));
  }
}

export async function cancelSignIn(): Promise<void> {
  await invoke('gh.auth.cancelLogin');
  store.set({ login: { inProgress: false, code: null, url: null, error: null } });
}

export async function signOut(host: string): Promise<void> {
  try {
    await invoke('gh.auth.logout', host);
    await refreshTools();
  } catch (err) {
    showError('Sign out failed', err);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  try {
    const settings = await invoke('app.settings.set', patch);
    store.set({ settings });
    applyTheme(settings, store.get().dark);
    if (patch.diffHideWhitespace !== undefined) void loadDiff(true);
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

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export async function handleMenuAction(action: string, args?: unknown): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  const needsRepo = () => {
    if (!repo) showToast({ kind: 'info', title: 'Open a repository first' });
    return !!repo;
  };
  switch (action) {
    case 'new-repository':
      return openDialog({ kind: 'new-repo' });
    case 'add-local-repository':
      return openDialog({ kind: 'add-repo' });
    case 'clone-repository':
      return openDialog({ kind: 'clone' });
    case 'settings':
      return openDialog({ kind: 'settings' });
    case 'command-palette':
      return openCommandPalette();
    case 'export-settings':
      return openDialog({ kind: 'export-settings' });
    case 'import-settings':
      return openDialog({ kind: 'import-settings' });
    case 'show-changes':
      return setView('changes');
    case 'show-history':
      return setView('history');
    case 'show-stashes':
      if (needsRepo()) return setView('stashes');
      return;
    case 'show-worktrees':
      if (needsRepo()) openDialog({ kind: 'worktrees' });
      return;
    case 'show-submodules':
      if (needsRepo()) openDialog({ kind: 'submodules' });
      return;
    case 'show-lfs':
      if (needsRepo()) openDialog({ kind: 'lfs' });
      return;
    case 'show-health':
      if (needsRepo()) return openHealth();
      return;
    case 'show-repository-list':
      return store.set((st) => ({ popover: st.popover === 'repos' ? null : 'repos' }));
    case 'show-branches-list':
      if (needsRepo()) store.set((st) => ({ popover: st.popover === 'branches' ? null : 'branches' }));
      return;
    case 'focus-commit-summary':
      setView('changes');
      document.getElementById('commit-summary')?.focus();
      return;
    case 'toggle-split-diff':
      return updateSettings({ diffViewMode: s.settings?.diffViewMode === 'split' ? 'unified' : 'split' });
    case 'toggle-whitespace':
      return updateSettings({ diffHideWhitespace: !s.settings?.diffHideWhitespace });
    case 'toggle-blame':
      return toggleBlame();
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset':
      await invoke('app.zoom', action === 'zoom-in' ? 'in' : action === 'zoom-out' ? 'out' : 'reset');
      return;
    case 'push':
      if (needsRepo()) return pushWithErrorHandling();
      return;
    case 'pull':
      if (needsRepo()) return pull();
      return;
    case 'fetch':
      if (needsRepo()) return fetchRemote();
      return;
    case 'scan-watched-folders':
      return void scanWatchedFolders();
    case 'remove-repository':
      if (repo) openDialog({ kind: 'remove-repo', repo });
      return;
    case 'view-on-github':
      return viewOnGitHub();
    case 'open-in-shell':
      if (needsRepo()) return openInShell();
      return;
    case 'show-in-folder':
      if (needsRepo()) return showInFolder();
      return;
    case 'open-in-editor':
      if (needsRepo()) return openInEditor();
      return;
    case 'create-issue':
      if (repo?.github) void openExternal(`${repo.github.url}/issues/new`);
      return;
    case 'show-issues':
      if (needsRepo()) openIssuesDialog();
      return;
    case 'show-inbox':
      return toggleInboxPanel();
    case 'open-inbox-item':
      return openInboxItemById((args as { id: string }).id);
    case 'repository-settings':
      if (needsRepo()) openDialog({ kind: 'repo-settings' });
      return;
    case 'release-notes':
      if (needsRepo()) openReleaseNotes();
      return;
    case 'split-commits':
      if (needsRepo()) openSplitDialog();
      return;
    case 'tidy-branch-ai':
      if (needsRepo()) tidyBranch();
      return;
    case 'new-branch':
      if (needsRepo()) openDialog({ kind: 'new-branch' });
      return;
    case 'rename-branch':
      if (repo && s.status?.branch.name) openDialog({ kind: 'rename-branch', branch: s.status.branch.name });
      return;
    case 'delete-branch': {
      const current = s.branches.find((b) => b.isCurrent);
      if (repo && current) openDialog({ kind: 'delete-branch', branch: current });
      return;
    }
    case 'discard-all-changes':
      if (repo && s.status?.files.length) requestDiscard(s.status.files.map((f) => f.path), true);
      return;
    case 'stash-all-changes':
      if (repo && s.status?.files.length) return stashAll();
      return;
    case 'update-from-default':
      if (needsRepo()) return updateFromDefaultBranch();
      return;
    case 'compare-branch':
      if (needsRepo()) openDialog({ kind: 'compare' });
      return;
    case 'merge-branch':
      if (needsRepo()) openDialog({ kind: 'merge', squash: false });
      return;
    case 'squash-merge-branch':
      if (needsRepo()) openDialog({ kind: 'merge', squash: true });
      return;
    case 'rebase-branch':
      if (needsRepo()) openDialog({ kind: 'rebase' });
      return;
    case 'compare-on-github':
      return compareOnGitHub();
    case 'view-pull-request':
      if (s.prs.current) void openExternal(s.prs.current.url);
      else showToast({ kind: 'info', title: 'No pull request for this branch' });
      return;
    case 'create-pull-request':
      if (needsRepo()) return openPullRequestFlow();
      return;
    case 'review-branch':
      if (needsRepo()) reviewBranch();
      return;
    case 'review-pull-request':
      if (needsRepo()) reviewCurrentPullRequest();
      return;
    case 'draft-pull-request-ai':
      if (needsRepo()) return draftPullRequest();
      return;
    case 'keyboard-shortcuts':
      return openDialog({ kind: 'shortcuts' });
    case 'show-logs': {
      const info = await invoke('app.info');
      await invoke('app.showItemInFolder', info.logPath);
      return;
    }
    case 'about':
      return openDialog({ kind: 'about' });
    case 'check-for-updates':
      return checkForUpdates();
    case 'find':
      if (s.view === 'history') document.getElementById('history-search')?.focus();
      else document.getElementById('changes-filter')?.focus();
      return;
    case 'search-history-selection': {
      const text = window.getSelection()?.toString() ?? '';
      if (!needsRepo()) return;
      if (text.trim()) searchHistoryForSelection(text);
      else showToast({ kind: 'info', title: 'Select some text in the diff first' });
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// AI diff explanation
// ---------------------------------------------------------------------------

/** True when the AI provider is enabled; entry points across the app are hidden (not disabled) when it is not. */
export function aiExplainAvailable(): boolean {
  return (store.get().settings?.ai.provider ?? 'disabled') !== 'disabled';
}

/** Source (commit/working tree/stash) implied by the tab currently showing a diff, or null when explaining is not meaningful there (e.g. the AI review view). */
function currentExplainSource(): ExplainSource | null {
  const s = store.get();
  if (s.review.open) return null;
  if (s.view === 'changes') return { kind: 'working' };
  if (s.view === 'history' && s.history.selectedShas.length === 1) return { kind: 'commit', sha: s.history.selectedShas[0] };
  if (s.view === 'stashes' && s.stashesView.selectedSha) {
    const stash = s.stashes.find((st) => st.sha === s.stashesView.selectedSha);
    if (stash) return { kind: 'stash', ref: stash.sha };
  }
  return null;
}

/** Path currently shown in the diff pane for the active tab, if any. */
function currentExplainPath(): string | null {
  const s = store.get();
  if (s.view === 'changes') return s.changes.selectedPaths.length === 1 ? s.changes.selectedPaths[0] : null;
  if (s.view === 'history') return s.history.selectedFile;
  if (s.view === 'stashes') return s.stashesView.selectedFile;
  return null;
}

async function runExplain(target: ExplainTarget, label: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  patchExplain({ open: true, panelCollapsed: false, target, label, loading: true, error: null, result: null, followUps: [], followUpDraft: '', followUpError: null });
  try {
    const result = await invoke('ai.explain', repo.path, target);
    if (store.get().explain.target !== target) return; // superseded by a newer request
    patchExplain({ result, loading: false, error: null });
  } catch (err) {
    if (store.get().explain.target !== target) return;
    if (err instanceof ApiError && err.code === 'cancelled') {
      patchExplain({ loading: false });
      return;
    }
    patchExplain({ loading: false, error: errorMessage(err) });
  }
}

export function explainCommit(sha: string): void {
  void runExplain({ kind: 'commit', sha }, `Commit ${sha.slice(0, 7)}`);
}

/** Explains the file currently shown in the diff pane for the active tab (Changes or History). */
export function explainCurrentFile(): void {
  const source = currentExplainSource();
  const path = currentExplainPath();
  if (!source || !path) return;
  void runExplain({ kind: 'file', source, path }, path);
}

/** Explains a range of new-side lines [startLine, endLine] within hunk `hunkIndex` of the file currently shown in the diff pane. */
export function explainSelectedLines(path: string, hunkIndex: number, startLine: number, endLine: number): void {
  const source = currentExplainSource();
  if (!source) return;
  const label = `${path}:${startLine}${endLine !== startLine ? `-${endLine}` : ''}`;
  void runExplain({ kind: 'range', source, path, hunkIndex, startLine, endLine }, label);
}

export function retryExplain(): void {
  const { target, label } = store.get().explain;
  if (target) void runExplain(target, label ?? '');
}

export function cancelExplain(): void {
  void invoke('ai.cancel');
  patchExplain({ loading: false, followUpLoading: false });
}

export function closeExplainPanel(): void {
  patchExplain({ ...initialExplain, width: store.get().explain.width });
}

export function toggleExplainPanelCollapsed(): void {
  patchExplain({ panelCollapsed: !store.get().explain.panelCollapsed });
}

export function setExplainPanelWidth(width: number): void {
  patchExplain({ width: saveExplainPanelWidth(width) });
}

export function setExplainFollowUpDraft(text: string): void {
  patchExplain({ followUpDraft: text });
}

export async function askExplainFollowUp(): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  const { target, followUps, followUpDraft } = s.explain;
  const question = followUpDraft.trim();
  if (!repo || !target || !question || followUps.length >= EXPLAIN_FOLLOWUP_LIMIT) return;
  patchExplain({ followUpLoading: true, followUpError: null });
  try {
    const answer = await invoke('ai.explain.followUp', repo.path, target, followUps, question);
    if (store.get().explain.target !== target) return;
    patchExplain((e) => ({ followUps: [...e.followUps, { question, answer }], followUpLoading: false, followUpDraft: '' }));
  } catch (err) {
    if (store.get().explain.target !== target) return;
    patchExplain({ followUpLoading: false, followUpError: errorMessage(err) });
  }
}

export function copyExplanationMarkdown(): void {
  const { result, target } = store.get().explain;
  if (!result || !target) return;
  void copyToClipboard(explanationToMarkdown(result, target), 'Explanation copied');
}

/** Scrolls the currently visible diff (in whichever tab is showing one) to the given new-side line, briefly flashing the row. */
export function scrollDiffToLine(line: number | null): void {
  if (line === null) return;
  const row = document.querySelector<HTMLElement>(`.diff-pane tr[data-new-line="${line}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash-highlight');
  setTimeout(() => row.classList.remove('flash-highlight'), 1200);
}

/** Clicking an explanation reference: switches to that file in the active tab's file list when needed, then scrolls the diff to the line. */
export function focusExplainReference(path: string, line: number | null): void {
  const s = store.get();
  let switching = false;
  if (s.view === 'history' && s.history.selectedFile !== path && (s.history.details?.files.some((f) => f.path === path) ?? false)) {
    selectCommitFile(path);
    switching = true;
  } else if (s.view === 'changes' && s.changes.selectedPaths[0] !== path && (s.status?.files.some((f) => f.path === path) ?? false)) {
    selectWorkingFile(path);
    switching = true;
  } else if (s.view === 'stashes' && s.stashesView.selectedFile !== path && s.stashesView.files.some((f) => f.path === path)) {
    selectStashViewFile(path);
    switching = true;
  }
  if (switching) setTimeout(() => scrollDiffToLine(line), 250);
  else scrollDiffToLine(line);
}

// ---------------------------------------------------------------------------
// AI error explanation
// ---------------------------------------------------------------------------

/** Resets the "Explain with AI" section; the error dialog calls this once on mount so a previous error's stale result never shows for a new one, even one with the same code. */
export function resetErrorExplanation(): void {
  patchErrorExplain(initialErrorExplain);
}

export async function requestErrorExplanation(error: GitErrorInfo, retryable: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  patchErrorExplain({ forCode: error.code, loading: true, error: null, result: null, feedbackGiven: false });
  try {
    const result = await invoke('ai.explainError', repo?.path ?? null, error, retryable);
    if (store.get().errorExplain.forCode !== error.code) return; // superseded (dialog closed/reopened, or Retry ran and changed the error)
    patchErrorExplain({ loading: false, result });
  } catch (err) {
    if (store.get().errorExplain.forCode !== error.code) return;
    patchErrorExplain({ loading: false, error: errorMessage(err) });
  }
}

export function cancelErrorExplanation(): void {
  void invoke('ai.cancel');
  patchErrorExplain({ loading: false });
}

/** Local-only feedback counter; never sent anywhere (see AiErrorFeedback in store.ts). */
export function recordErrorExplanationFeedback(helpful: boolean): void {
  if (store.get().errorExplain.feedbackGiven) return;
  store.set((s) => ({ aiErrorFeedback: { helpful: s.aiErrorFeedback.helpful + (helpful ? 1 : 0), notHelpful: s.aiErrorFeedback.notHelpful + (helpful ? 0 : 1) } }));
  patchErrorExplain({ feedbackGiven: true });
}

async function runErrorFixAction(action: NonNullable<ErrorFix['action']>, repo: RepositoryInfo | null, status: RepositoryStatus | null): Promise<void> {
  switch (action) {
    case 'fetch':
      await fetchRemote();
      return;
    case 'pull':
      await pull();
      return;
    case 'fetch-and-pull':
      await fetchRemote();
      await pull();
      return;
    case 'push-set-upstream':
    case 'force-push-with-lease':
      // Both map onto the same smart push: it already sets upstream when the branch has none, and
      // opens the normal force-push confirmation when the branch has diverged from its upstream.
      await push();
      return;
    case 'stash-and-retry':
      await stashAll();
      return;
    case 'discard-and-retry':
      if (status) requestDiscard(status.files.map((f) => f.path), true);
      return;
    case 'remove-lock-file':
      if (repo) await requestRemoveLockFile(repo.path);
      return;
    case 'abort-merge':
    case 'abort-rebase':
    case 'abort-cherry-pick':
    case 'abort-revert':
      await abortOperation();
      return;
    case 'continue-rebase':
      await continueOperation();
      return;
    case 'open-sign-in':
      openDialog({ kind: 'sign-in' });
      return;
    case 'open-remote-settings':
      if (repo) openDialog({ kind: 'repo-settings', tab: 'remote' });
      return;
    case 'open-identity-settings':
      if (repo) openDialog({ kind: 'repo-settings', tab: 'identity' });
      return;
    case 'rename-branch':
      if (status?.branch.name) openDialog({ kind: 'rename-branch', branch: status.branch.name });
      return;
    case 'open-in-terminal':
      if (repo) await openInShellAt(repo.path);
      return;
  }
}

/**
 * Applies an AI-suggested action fix by dispatching to the same action
 * functions the menus use, so every existing confirmation (discard, force
 * push, sign-in…) still applies. Closes the error dialog first. Copy-only
 * fixes (no `action`) are handled directly by the dialog (copy / Run in
 * terminal) and never reach this function. `retry` re-runs the operation
 * that originally failed and is only invoked when the fix ran to completion
 * without opening a further dialog of its own (a still-open confirmation
 * means the fix itself is not done yet).
 */
export async function applyErrorFix(fix: ErrorFix, retry?: () => void): Promise<void> {
  if (!fix.action) return;
  const repo = store.get().currentRepo;
  const status = store.get().status;
  closeAllDialogs();
  await runErrorFixAction(fix.action, repo, status);
  if (fix.retryAfter && retry && !store.get().dialog) retry();
}

/** The remove-lock-file fix's confirmation; the actual safety guard (no running git process, lock at least 10s old) is enforced in the main process and reported back here. */
export async function requestRemoveLockFile(repoPath: string): Promise<void> {
  openDialog({
    kind: 'confirm',
    title: 'Remove stale lock file?',
    message: 'This deletes .git/index.lock. Only do this when you are sure no other Git process — including this app, mid-operation — is using the repository right now.',
    confirmLabel: 'Remove lock file',
    danger: true,
    onConfirm: async () => {
      try {
        const result = await invoke('git.removeLockFile', repoPath);
        if (result.removed) {
          showToast({ kind: 'success', title: 'Lock file removed' });
          await refreshStatus();
        } else {
          showToast({ kind: 'warning', title: 'Could not remove the lock file', message: result.reason ?? undefined });
        }
      } catch (err) {
        showError('Could not remove the lock file', err);
      }
    },
  });
}

export function dialogOpen(): DialogState | null {
  return store.get().dialog;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export { closeDialog, openDialog, showToast, closeAllDialogs };
export type { Commit };
