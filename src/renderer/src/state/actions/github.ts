import type { PrTriage, PullRequest, TriageState } from '@shared/types';
import { aiEnabled } from '@shared/ai-model';
import { issueBranchSlug } from '@shared/util';
import { errorInfo, errorMessage, invoke } from '../../api';
import { closeAllDialogs, closeDialog, openDialog, patchChanges, patchTriage, showToast, store } from '../store';
import { refreshTools, showError } from './core';
import { refreshAll } from './repo';
import { loadHistory } from './view';
import { pushWithErrorHandling } from './branches';
import { withUncommittedChanges } from './shared';

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
    if (aiEnabled(settings, store.get().currentRepo) && settings?.ai.triageAutoRefresh) void summarizePullRequests();
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
  void invoke('ai.cancel', 'triage');
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

export async function signOut(host: string, login?: string): Promise<void> {
  try {
    await invoke('gh.auth.logout', host, login);
    await refreshTools();
  } catch (err) {
    showError('Sign out failed', err);
  }
}

/** Makes `login` the account GitHub calls use by default on `host`; repositories with their own account are unaffected. */
export async function switchAccount(host: string, login: string): Promise<void> {
  try {
    await invoke('gh.auth.switch', host, login);
    await refreshTools();
  } catch (err) {
    showError('Could not switch account', err);
  }
}
