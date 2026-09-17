import type { Branch, Commit, CommitOptions, FileDiff, PullRequest, RepositoryInfo, RepositoryStatus, Stash, UncommittedChangesStrategy, WorkingFile, ConflictResolutionResult, AppSettings } from '@shared/types';
import type { OperationOutcome } from '@shared/ipc';
import { buildStagePatch } from '@shared/diff/patch';
import { ApiError, errorInfo, errorMessage, invoke, on } from '../api';
import { closeAllDialogs, closeDialog, initialChanges, initialDiff, initialHistory, openDialog, patchChanges, patchDiff, patchHistory, showToast, store, type DialogState } from './store';

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
  const [settings, tools, repos] = await Promise.all([invoke('app.settings.get'), invoke('app.tools', false), invoke('repos.list')]);
  store.set({ settings, tools, repos });
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
    store.set({ tools: t });
    if (t.git.installed && !hadGit && store.get().currentRepo && !store.get().status) {
      void refreshAll().then(() => loadHistory(true));
    }
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
    else void handleMenuAction(action);
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
  on('window.focus', ({ focused }) => {
    store.set({ focused });
    if (focused && store.get().currentRepo) void refreshStatus();
  });

  setInterval(() => void pollPullRequestNotifications(), 3 * 60_000);

  const candidates = repos.filter((r) => !r.missing).sort((a, b) => b.lastOpened - a.lastOpened);
  if (candidates.length) await openRepository(candidates[0]);

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

let repoChangeTimer: ReturnType<typeof setTimeout> | null = null;
async function handleRepoChanged(reason: 'worktree' | 'refs' | 'both'): Promise<void> {
  if (repoChangeTimer) clearTimeout(repoChangeTimer);
  repoChangeTimer = setTimeout(async () => {
    repoChangeTimer = null;
    await refreshStatus();
    if (reason !== 'worktree') {
      await Promise.all([refreshBranches(), refreshStashes()]);
      if (store.get().view === 'history') await loadHistory(true);
    }
    await loadDiff(true);
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
  openDialog({ kind: 'error', title, error: info, retry });
}

/** Runs a long git operation, surfacing it in the toolbar and reporting errors. */
export async function runOperation<T>(label: string, fn: () => Promise<T>, opts: { silent?: boolean; refresh?: boolean } = {}): Promise<T | undefined> {
  store.set({ operation: label });
  try {
    const result = await fn();
    return result;
  } catch (err) {
    if (!opts.silent) showError(`${label} failed`, err);
    return undefined;
  } finally {
    store.set({ operation: null });
    if (opts.refresh !== false) void refreshAll();
  }
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
    diff: initialDiff,
    prs: { list: [], loading: false, current: null, loadedAt: 0, error: null },
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

export async function removeRepository(repo: RepositoryInfo, moveToTrash: boolean): Promise<void> {
  try {
    await invoke('repos.remove', repo.id, moveToTrash);
    const list = await invoke('repos.list');
    store.set({ repos: list });
    if (store.get().currentRepo?.id === repo.id) {
      const next = list.filter((r) => !r.missing).sort((a, b) => b.lastOpened - a.lastOpened)[0];
      if (next) await openRepository(next);
      else {
        store.set({ currentRepo: null, status: null, branches: [], changes: initialChanges, history: initialHistory, diff: initialDiff });
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
  await Promise.all([refreshStatus(), refreshBranches(), refreshStashes(), refreshRemotes()]);
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
  if (!changes.selectedPaths.length && status.files.length && !changes.showingStash) changes.selectedPaths = [status.files[0].path];
  const previousConflicts = s.status?.hasConflicts ?? false;
  store.set({ status, changes });
  if (store.get().view === 'changes') void loadDiff();
  if (previousConflicts && !status.hasConflicts && status.operation.kind === 'none' && s.status?.operation.kind === 'merge') {
    store.set({ lastSuccessfulMerge: { branch: s.status.operation.targetName ?? 'branch', at: Date.now() } });
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
    const showing = store.get().changes.showingStash;
    if (showing && !stashes.some((st) => st.sha === showing.sha)) patchChanges({ showingStash: null, stashFiles: [], stashSelectedFile: null });
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

export function setView(view: 'changes' | 'history'): void {
  if (store.get().view === view) return;
  store.set({ view });
  if (view === 'history') {
    const h = store.get().history;
    if (!h.commits.length) void loadHistory(true);
    else if (!h.selectedShas.length) selectCommit(h.commits[0].sha);
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
  patchChanges({ selectedPaths: selected, showingStash: null, stashSelectedFile: null });
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
}

export function setAllIncluded(included: boolean): void {
  const s = store.get();
  patchChanges({ excluded: included ? [] : (s.status?.files ?? []).map((f) => f.path), partial: {} });
  patchDiff({ selectedLines: null });
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
  patchHistory({ detailsLoading: true });
  try {
    const details = await invoke('repo.commit.details', repo.path, sha);
    const h = store.get().history;
    if (h.selectedShas[0] !== sha || h.selectedShas.length !== 1) {
      patchHistory({ detailsLoading: false });
      return;
    }
    const selectedFile = h.selectedFile && details.files.some((f) => f.path === h.selectedFile) ? h.selectedFile : details.files[0]?.path ?? null;
    patchHistory({ details, detailsLoading: false, selectedFile });
    void loadDiff();
  } catch (err) {
    patchHistory({ detailsLoading: false });
    showToast({ kind: 'error', title: 'Could not load commit', message: errorMessage(err) });
  }
}

export async function loadHistory(reset: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const h = store.get().history;
  if (h.loading && !reset) return;
  patchHistory({ loading: true });
  try {
    const skip = reset ? 0 : h.commits.length;
    const page = await invoke('repo.history', repo.path, { ref: null, skip, limit: HISTORY_PAGE, path: null, search: h.search.trim() || null });
    if (store.get().currentRepo?.path !== repo.path) return;
    const commits = reset ? page.commits : [...h.commits, ...page.commits];
    const stillSelected = store.get().history.selectedShas.filter((sha) => commits.some((c) => c.sha === sha));
    patchHistory({ commits, hasMore: page.hasMore, loading: false, selectedShas: stillSelected, details: stillSelected.length === 1 ? store.get().history.details : null });
    if (store.get().view === 'history' && stillSelected.length === 0 && commits.length) selectCommit(commits[0].sha);
    else if (stillSelected.length === 1 && reset) void loadCommitDetails(stillSelected[0]);
  } catch (err) {
    patchHistory({ loading: false });
    showToast({ kind: 'error', title: 'Could not load history', message: errorMessage(err) });
  }
}

export function setHistorySearch(search: string): void {
  patchHistory({ search });
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadHistory(true), 300);
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export async function loadDiff(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo) {
    patchDiff({ key: null, diff: null, loading: false, error: null, selectedLines: null });
    return;
  }
  const opts = { hideWhitespace: s.settings?.diffHideWhitespace ?? false };
  let key: string | null = null;
  let fetcher: (() => Promise<FileDiff>) | null = null;
  let selectedLines: string[] | null = null;
  if (s.view === 'changes') {
    if (s.changes.showingStash) {
      const stash = s.changes.showingStash;
      const f = s.changes.stashSelectedFile;
      if (f) {
        key = `stash:${stash.sha}:${f}`;
        fetcher = () => invoke('repo.diff.stash', repo.path, stash.ref, f, opts);
      }
    } else if (s.changes.selectedPaths.length === 1) {
      const path = s.changes.selectedPaths[0];
      key = `working:${path}`;
      fetcher = () => invoke('repo.diff.working', repo.path, path, opts);
      selectedLines = s.changes.excluded.includes(path) ? [] : s.changes.partial[path] ?? null;
    }
  } else if (s.history.selectedShas.length === 1 && s.history.selectedFile) {
    const sha = s.history.selectedShas[0];
    const f = s.history.selectedFile;
    key = `commit:${sha}:${f}`;
    fetcher = () => invoke('repo.commit.diff', repo.path, sha, f, opts);
  }
  if (!key || !fetcher) {
    patchDiff({ key: null, diff: null, loading: false, error: null, selectedLines: null });
    return;
  }
  key += `|ws=${opts.hideWhitespace}`;
  if (!force && s.diff.key === key && (s.diff.diff || s.diff.loading)) return;
  const samePath = s.diff.key !== null && s.diff.key.split('|')[0] === key.split('|')[0];
  patchDiff({ key, loading: !samePath || !s.diff.diff, error: null, selectedLines, diff: samePath ? s.diff.diff : null });
  try {
    const diff = await fetcher();
    if (store.get().diff.key !== key) return;
    patchDiff({ diff, loading: false, error: null });
  } catch (err) {
    if (store.get().diff.key !== key) return;
    patchDiff({ diff: null, loading: false, error: errorMessage(err) });
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
    showError('Commit failed', err);
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
    const last = store.get().history.commits[0] ?? (await invoke('repo.history', repo.path, { ref: null, skip: 0, limit: 1, path: null, search: null })).commits[0];
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

function hasUncommittedChanges(): boolean {
  const status = store.get().status;
  return !!status && status.files.length > 0;
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
      } else {
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
    showError(`Could not switch to ${branch.name}`, err);
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
      } else showError(`Could not create branch ${name}`, err);
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
  await runOperation(`Abort ${kind}`, () => invoke(method, repo.path));
  closeAllDialogs();
  await loadHistory(true);
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
  store.set({ aiBusy: true });
  try {
    const result = await invoke('ai.resolve', repo.path, path);
    handleResolution(result);
  } catch (err) {
    showError('AI resolution failed', err);
  } finally {
    store.set({ aiBusy: false });
    await refreshStatus();
    await loadDiff(true);
  }
}

export async function resolveAllWithAi(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  store.set({ aiBusy: true });
  try {
    const results = await invoke('ai.resolveAll', repo.path);
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (ok.length) {
      showToast({ kind: 'success', title: `AI resolved ${ok.length} file${ok.length === 1 ? '' : 's'}`, message: ok.some((r) => r.blocks.some((b) => b.confidence === 'low')) ? 'Some resolutions have low confidence; review them before committing.' : undefined, action: { label: 'Undo all', onClick: () => void undoResolutions(ok) } }, 12000);
    }
    for (const f of failed) showToast({ kind: 'error', title: `Could not resolve ${f.path}`, message: f.error ?? undefined }, 10000);
  } catch (err) {
    showError('AI resolution failed', err);
  } finally {
    store.set({ aiBusy: false });
    await refreshStatus();
    await loadDiff(true);
  }
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
  await refreshStatus();
  await loadDiff(true);
}

export async function useSide(path: string, side: 'ours' | 'theirs'): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.conflict.useSide', repo.path, path, side);
    await refreshStatus();
    await loadDiff(true);
  } catch (err) {
    showError('Could not resolve conflict', err);
  }
}

export async function markResolved(paths: string[]): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('git.conflict.markResolved', repo.path, paths);
    await refreshStatus();
    await loadDiff(true);
  } catch (err) {
    showError('Could not mark as resolved', err);
  }
}

/** Writes an edited conflict file (manual per-block resolution in the diff view). */
export async function writeResolvedContent(path: string, content: string, stillHasConflicts: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    await invoke('repo.writeFile', repo.path, path, content);
    if (!stillHasConflicts && store.get().settings?.ai.autoStageAfterResolve !== false) await invoke('git.conflict.markResolved', repo.path, [path]);
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
      if (existing) await invoke('git.stash.drop', repo.path, existing.ref);
      await invoke('git.stash.push', repo.path, null, true, null);
      await refreshAll();
      await loadDiff(true);
      showToast({ kind: 'success', title: 'Changes stashed' });
    } catch (err) {
      showError('Could not stash changes', err);
    }
  };
  if (existing && s.settings?.confirmDiscardStash !== false) {
    openDialog({ kind: 'confirm', title: 'Overwrite stash?', message: `A stash created by GitGood already exists on ${s.status?.branch.name}. Stashing again will overwrite it.`, confirmLabel: 'Overwrite', danger: true, onConfirm: perform });
  } else await perform();
}

export async function viewStash(stash: Stash | null): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  if (!stash) {
    patchChanges({ showingStash: null, stashFiles: [], stashSelectedFile: null });
    void loadDiff();
    return;
  }
  patchChanges({ showingStash: stash, stashFiles: [], stashSelectedFile: null, selectedPaths: [] });
  try {
    const files = await invoke('repo.stash.files', repo.path, stash.ref);
    if (store.get().changes.showingStash?.sha !== stash.sha) return;
    patchChanges({ stashFiles: files, stashSelectedFile: files[0]?.path ?? null });
    void loadDiff();
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not load stash', message: errorMessage(err) });
  }
}

export function selectStashFile(path: string): void {
  patchChanges({ stashSelectedFile: path });
  void loadDiff();
}

export async function restoreStash(stash: Stash, pop = true): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const outcome = await runOperation('Restore stash', () => invoke(pop ? 'git.stash.pop' : 'git.stash.apply', repo.path, stash.ref));
  if (outcome?.status === 'conflicts') showToast({ kind: 'warning', title: 'Stash restored with conflicts', message: 'Resolve the conflicted files, then the stash can be dropped.' });
  else if (outcome) {
    patchChanges({ showingStash: null, stashFiles: [], stashSelectedFile: null });
    showToast({ kind: 'success', title: 'Stash restored' });
  }
  await loadDiff(true);
}

export async function dropStash(stash: Stash): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const perform = async () => {
    try {
      await invoke('git.stash.drop', repo.path, stash.ref);
      patchChanges({ showingStash: null, stashFiles: [], stashSelectedFile: null });
      await refreshStashes();
      void loadDiff();
    } catch (err) {
      showError('Could not discard stash', err);
    }
  };
  if (store.get().settings?.confirmDiscardStash !== false) openDialog({ kind: 'confirm', title: 'Discard stash?', message: 'The stashed changes will be permanently lost.', confirmLabel: 'Discard', danger: true, onConfirm: perform });
  else await perform();
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
  } catch (err) {
    const info = errorInfo(err);
    store.set((st) => ({ prs: { ...st.prs, loading: false, error: info.message } }));
  }
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

export function openPullRequestFlow(): void {
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
  openDialog({ kind: 'create-pr' });
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
// Menu
// ---------------------------------------------------------------------------

export async function handleMenuAction(action: string): Promise<void> {
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
    case 'show-changes':
      return setView('changes');
    case 'show-history':
      return setView('history');
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
    case 'repository-settings':
      if (needsRepo()) openDialog({ kind: 'repo-settings' });
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
    case 'keyboard-shortcuts':
      return openDialog({ kind: 'shortcuts' });
    case 'show-logs': {
      const info = await invoke('app.info');
      await invoke('app.showItemInFolder', info.logPath);
      return;
    }
    case 'about':
      return openDialog({ kind: 'about' });
    case 'find':
      if (s.view === 'history') document.getElementById('history-search')?.focus();
      else document.getElementById('changes-filter')?.focus();
      return;
    default:
      return;
  }
}

export function dialogOpen(): DialogState | null {
  return store.get().dialog;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export { closeDialog, openDialog, showToast, closeAllDialogs };
export type { Commit };
