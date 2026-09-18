import type { PostReviewOptions, PullRequest, ReviewFinding, ReviewStartOptions, ReviewTarget } from '@shared/types';
import { errorMessage, invoke } from '../api';
import { loadDiff, showError } from './actions';
import { closeDialog, initialReview, openDialog, patchReview, showToast, store, type PrReviewRun } from './store';

// ---------------------------------------------------------------------------
// AI pull request review
// ---------------------------------------------------------------------------

export function aiReviewAvailable(): boolean {
  const s = store.get();
  return !!s.currentRepo && s.settings?.ai.provider !== 'disabled';
}

/** True when the repository has a GitHub remote and gh is signed in, so pull request mode is possible. */
export function pullRequestReviewAvailable(): boolean {
  const s = store.get();
  return aiReviewAvailable() && !!s.currentRepo?.github && !!s.tools?.gh.installed && !!s.tools?.ghAccount;
}

function sameTarget(a: ReviewTarget | PrReviewRun['target'], b: ReviewTarget | PrReviewRun['target']): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'pr' ? a.number === (b as { number: number }).number : a.base === (b as { base: string }).base;
}

/** Opens the pre-flight card for a target (the entry point used by menus and buttons). */
export function openReviewPreflight(target: ReviewTarget): void {
  if (!aiReviewAvailable()) {
    showToast({ kind: 'info', title: 'AI features are turned off', message: 'Enable a provider under Options → AI.', action: { label: 'Options', onClick: () => openDialog({ kind: 'settings', tab: 'ai' }) } });
    return;
  }
  if (target.kind === 'pr' && !pullRequestReviewAvailable()) {
    showToast({ kind: 'info', title: 'Sign in to GitHub to review pull requests', action: { label: 'Sign in', onClick: () => openDialog({ kind: 'sign-in' }) } });
    return;
  }
  store.set({ popover: null });
  openDialog({ kind: 'review-preflight', target });
  void loadReviewPlan(target);
}

export async function loadReviewPlan(target: ReviewTarget): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  patchReview({ plan: null, planLoading: true, planError: null });
  try {
    const plan = await invoke('ai.review.plan', repo.path, target);
    patchReview({ plan, planLoading: false, currentHeadSha: plan.target.headSha });
  } catch (err) {
    patchReview({ planLoading: false, planError: errorMessage(err) });
  }
}

/** Review the current branch against the default (or given) base branch. Works without gh. */
export function reviewBranch(base?: string): void {
  const s = store.get();
  if (!s.currentRepo) {
    showToast({ kind: 'info', title: 'Open a repository first' });
    return;
  }
  const target = base ?? s.defaultBranch ?? 'main';
  if (s.status?.branch.name === target) {
    showToast({ kind: 'info', title: `You are on ${target}`, message: 'Switch to a feature branch to review it against the base branch.' });
    return;
  }
  openReviewPreflight({ kind: 'branch', base: target });
}

/** Review the pull request for the current branch, falling back to branch mode. */
export function reviewCurrentPullRequest(): void {
  const s = store.get();
  const pr = s.prs.current;
  if (pr && pr.state === 'OPEN' && pullRequestReviewAvailable()) openReviewPreflight({ kind: 'pr', number: pr.number });
  else if (!s.currentRepo?.github || !s.tools?.ghAccount) reviewBranch();
  else showToast({ kind: 'info', title: 'No open pull request for this branch', message: 'Reviewing the branch against the default branch instead.', action: { label: 'Review branch', onClick: () => reviewBranch() } });
}

export function reviewPullRequest(pr: PullRequest): void {
  openReviewPreflight({ kind: 'pr', number: pr.number });
}

export async function startReview(target: ReviewTarget, opts: ReviewStartOptions = {}): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  closeDialog();
  const previous = store.get().review.run;
  const keepFindings = previous && sameTarget(previous.target, target) && opts.rereviewOf === previous.id;
  patchReview({ running: true, progress: null, open: true, run: keepFindings ? previous : null, selectedPath: keepFindings ? store.get().review.selectedPath : null, activeFindingId: null });
  try {
    const run = (await invoke('ai.review.start', repo.path, target, opts)) as PrReviewRun;
    if (store.get().currentRepo?.path !== repo.path) return;
    const firstWithFindings = run.findings.find((f) => !f.dismissed)?.path ?? run.files.find((f) => f.status === 'reviewed')?.file.path ?? null;
    patchReview((r) => ({ run, running: false, progress: null, currentHeadSha: run.target.headSha, selectedPath: r.selectedPath && run.files.some((f) => f.file.path === r.selectedPath) ? r.selectedPath : firstWithFindings }));
    void loadDiff(true);
    const live = run.findings.filter((f) => !f.dismissed);
    if (run.cancelled) showToast({ kind: 'warning', title: 'Review cancelled', message: live.length ? `${live.length} finding${live.length === 1 ? '' : 's'} collected before cancelling.` : undefined });
    else if (run.error) showToast({ kind: 'error', title: 'Review incomplete', message: run.error }, 12000);
    else showToast({ kind: live.some((f) => f.severity === 'blocker') ? 'warning' : 'success', title: live.length ? `${live.length} finding${live.length === 1 ? '' : 's'}` : 'No findings', message: run.summary.slice(0, 160) }, 10000);
  } catch (err) {
    patchReview({ running: false, progress: null });
    showError('AI review failed', err);
  }
}

export async function cancelReview(): Promise<void> {
  try {
    await invoke('ai.cancel');
  } catch {
    /* nothing running */
  }
}

/** Shows the most recent stored run for a target, if one exists. */
export async function openExistingReview(target: ReviewTarget): Promise<boolean> {
  const repo = store.get().currentRepo;
  if (!repo) return false;
  try {
    const run = (await invoke('ai.review.get', repo.path, target)) as PrReviewRun | null;
    if (!run) return false;
    patchReview({ run, open: true, selectedPath: run.findings[0]?.path ?? run.files.find((f) => f.status === 'reviewed')?.file.path ?? null, activeFindingId: null });
    void loadDiff(true);
    return true;
  } catch {
    return false;
  }
}

export function closeReview(): void {
  const r = store.get().review;
  patchReview({ ...initialReview, run: r.run, running: r.running, progress: r.progress, panelCollapsed: r.panelCollapsed });
  void loadDiff(true);
}

export function toggleReviewPanel(): void {
  patchReview((r) => ({ panelCollapsed: !r.panelCollapsed }));
}

export function selectReviewFile(path: string): void {
  patchReview({ selectedPath: path, activeFindingId: null });
  void loadDiff();
}

export function focusFinding(finding: ReviewFinding): void {
  const r = store.get().review;
  patchReview({ selectedPath: finding.path, activeFindingId: r.activeFindingId === finding.id && r.selectedPath === finding.path ? null : finding.id });
  void loadDiff();
}

export function setActiveFinding(id: string | null): void {
  patchReview({ activeFindingId: id });
}

export async function dismissFinding(finding: ReviewFinding, dismissed = true): Promise<void> {
  const s = store.get();
  const run = s.review.run;
  if (!run || !s.currentRepo) return;
  patchReview({ run: { ...run, findings: run.findings.map((f) => (f.id === finding.id ? { ...f, dismissed } : f)) }, activeFindingId: dismissed && s.review.activeFindingId === finding.id ? null : s.review.activeFindingId });
  try {
    await invoke('ai.review.dismiss', s.currentRepo.path, run.id, finding.id, dismissed);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not save the dismissal', message: errorMessage(err) });
  }
}

/** Re-runs the review on the same target; files whose diff is unchanged keep their findings. */
export function rereview(): void {
  const run = store.get().review.run;
  if (!run) return;
  const target: ReviewTarget = run.target.kind === 'pr' ? { kind: 'pr', number: run.target.number } : { kind: 'branch', base: run.target.base };
  void startReview(target, { rereviewOf: run.id });
}

export function openPostReview(): void {
  const run = store.get().review.run;
  if (!run || run.target.kind !== 'pr') return;
  openDialog({ kind: 'review-post' });
}

export async function postReview(opts: PostReviewOptions): Promise<{ url: string } | null> {
  const repo = store.get().currentRepo;
  if (!repo) return null;
  const result = await invoke('ai.review.post', repo.path, opts);
  showToast({ kind: 'success', title: 'Review posted to GitHub', message: result.url, action: { label: 'Open', onClick: () => void invoke('app.openExternal', result.url) } }, 12000);
  return result;
}

/** Whether the run shown no longer matches the target's head commit. */
export function reviewIsStale(): boolean {
  const s = store.get();
  const run = s.review.run;
  if (!run) return false;
  if (run.target.kind === 'pr') {
    const number = run.target.number;
    const pr = s.prs.current?.number === number ? s.prs.current : s.prs.list.find((p) => p.number === number);
    return !!pr?.headSha && pr.headSha !== run.target.headSha;
  }
  return !!s.status?.branch.sha && s.status.branch.sha !== run.target.headSha;
}

export function handleReviewProgress(e: import('@shared/types').AiReviewProgressEvent): void {
  patchReview({ progress: e });
}

export function patchReviewOpen(): void {
  patchReview({ open: true });
  void loadDiff(true);
}
