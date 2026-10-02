import { errorInfo, invoke, on } from '../../api';
import { openDialog, patchHistory, patchNlPalette, patchTriage, showToast, store } from '../store';
import { handleReviewProgress } from '../review';
import { handlePrecommitReviewProgress, refreshPrecommitStaleness } from '../precommitReview';
import { handleRebaseProgress } from '../rebase';
import { handleSplitProgress } from '../split';
import { initInbox, loadInboxState } from '../inbox';
import { handleProtocolReviewRerun } from '../agentHandoff';
import { openFolderAsRepository, openRepository, refreshAll, refreshStatus } from './repo';
import { refreshBranches, refreshStashes } from './conflicts';
import { clearBlameCache, loadDiff, loadHistory, selectWorkingFile } from './view';
import { checkoutBranch, fetchRemote } from './branches';
import { loadCurrentPullRequest } from './github';
import { handleMenuAction } from './menu';
import { applyTheme, pruneStaleConflictTints } from './shared';

// ---------------------------------------------------------------------------
// Bootstrap & events
// ---------------------------------------------------------------------------

let bootstrapped = false;

export async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  const settingsPromise = invoke('app.settings.get');
  const toolsPromise = invoke('app.tools', false);
  const reposPromise = invoke('repos.list');
  const updateStatePromise = invoke('app.update.state');
  const toolsWithStore = toolsPromise.then((tools) => { store.set({ tools }); return tools; });
  const updateStateWithStore = updateStatePromise.then((updateState) => { store.set({ updateState }); return updateState; });
  const [settings, repos] = await Promise.all([settingsPromise, reposPromise]);
  store.set({ settings, repos });
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
    // `aiConfigOff` comes from the repository's config file via `repo.open`, not from the list, so carry it over.
    const fresh = current ? list.find((r) => r.id === current.id) : undefined;
    store.set({ repos: list, currentRepo: current ? (fresh ? { ...fresh, aiConfigOff: current.aiConfigOff } : current) : null });
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
    else if (action === 'open-path') void openFolderAsRepository(args as { path: string });
    else if (action === 'protocol-review-rerun') void handleProtocolReviewRerun(args as { repoPath: string; token: string | null });
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

  // A window opened from the repository list starts on that repository (`#repo=<id>`), a blank one (`#repo=`) on none; the first window reopens the last used one.
  const wanted = new URLSearchParams(location.hash.slice(1)).get('repo');
  const candidates = repos.filter((r) => !r.missing && (wanted === null || r.id === wanted)).sort((a, b) => b.lastOpened - a.lastOpened);
  if (candidates.length) await openRepository(candidates[0]);
  const [tools] = await Promise.all([toolsWithStore, updateStateWithStore]);

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

/** The main process already coalesces watcher bursts (watcher.ts DEBOUNCE_MS); a second debounce here only added latency. Status refreshes dedupe via statusInFlight. */
async function handleRepoChanged(reason: 'worktree' | 'refs' | 'both'): Promise<void> {
  clearBlameCache();
  await refreshStatus();
  if (reason !== 'worktree') {
    await Promise.all([refreshBranches(), refreshStashes()]);
    if (store.get().view === 'history') await loadHistory(true);
    else patchHistory({ stale: true });
  }
  await loadDiff(true);
  if (store.get().precommitReview.run) void refreshPrecommitStaleness();
  const repo = store.get().currentRepo;
  if (repo && reason !== 'refs') void pruneStaleConflictTints(repo.path);
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
