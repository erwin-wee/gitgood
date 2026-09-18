import type { RebaseApplyProgress, RebasePlan, RebasePlanAction, RebasePlanRow } from '@shared/types';
import { errorMessage, invoke } from '../api';
import { hasUncommittedChanges, refreshAll, refreshStatus, showError } from './actions';
import { closeDialog, initialRebase, openDialog, patchRebase, showToast, store } from './store';

const UNDO_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Entry point gating
// ---------------------------------------------------------------------------

/** Hidden (not just disabled) when the AI provider is disabled, per spec. */
export function tidyBranchVisible(): boolean {
  const s = store.get();
  return !!s.currentRepo && s.settings?.ai.provider !== 'disabled';
}

/** Reason the action is not actionable right now (default branch, or a merge commit in a History multi-selection), or null when it can proceed. Full-range merge-commit detection is deferred to the pre-flight, since the whole "ahead of base" range is not necessarily loaded client-side. */
export function tidyBranchDisabledReason(shas: string[] | null): string | null {
  const s = store.get();
  if (!s.currentRepo) return null;
  if (s.status?.branch.name && s.defaultBranch && s.status.branch.name === s.defaultBranch) return `You're on ${s.defaultBranch}, the default branch.`;
  if (shas?.length) {
    const hasMerge = s.history.commits.some((c) => shas.includes(c.sha) && c.isMerge);
    if (hasMerge) return 'The selection includes a merge commit, which cannot be rewritten.';
  }
  return null;
}

function defaultBase(): string {
  const s = store.get();
  return s.defaultBranch ?? s.status?.branch.upstream?.replace(/^[^/]+\//, '') ?? 'main';
}

async function stashForTidy(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  await invoke('git.stash.push', repo.path, 'Before tidying with AI', true, null);
  await refreshStatus();
}

function beginTidy(shas: string[] | null): void {
  patchRebase({ ...initialRebase, shas, base: defaultBase() });
  openDialog({ kind: 'tidy-branch' });
  void loadRebasePreflight();
  void loadSigningWarning();
}

/** Entry point used by the Branch menu and the History context menu's multi-selection. */
export function tidyBranch(shas: string[] | null = null): void {
  const s = store.get();
  if (!s.currentRepo) {
    showToast({ kind: 'info', title: 'Open a repository first' });
    return;
  }
  if (!tidyBranchVisible()) {
    showToast({ kind: 'info', title: 'AI features are turned off', message: 'Enable a provider under Options → AI.', action: { label: 'Options', onClick: () => openDialog({ kind: 'settings', tab: 'ai' }) } });
    return;
  }
  const reason = tidyBranchDisabledReason(shas);
  if (reason) {
    showToast({ kind: 'info', title: reason });
    return;
  }
  if (!hasUncommittedChanges()) {
    beginTidy(shas);
    return;
  }
  const strategy = s.settings?.uncommittedChangesStrategy ?? 'ask';
  if (strategy === 'ask') {
    const count = s.status?.files.length ?? 0;
    openDialog({
      kind: 'confirm',
      title: 'Uncommitted changes',
      message: `You have ${count} uncommitted change${count === 1 ? '' : 's'}. They'll be stashed so the branch can be tidied; pop them from Stashes when you're done.`,
      confirmLabel: 'Stash and continue',
      onConfirm: async () => {
        await stashForTidy();
        beginTidy(shas);
      },
    });
    return;
  }
  void stashForTidy().then(() => beginTidy(shas));
}

// ---------------------------------------------------------------------------
// Pre-flight (no AI call)
// ---------------------------------------------------------------------------

export async function loadRebasePreflight(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const { base, shas } = store.get().rebase;
  patchRebase({ preflight: null, preflightLoading: true, preflightError: null });
  try {
    const preflight = await invoke('ai.rebase.preflight', repo.path, base, shas);
    patchRebase({ preflight, preflightLoading: false });
  } catch (err) {
    patchRebase({ preflightLoading: false, preflightError: errorMessage(err) });
  }
}

async function loadSigningWarning(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const info = await invoke('repo.signing.get', repo.path);
    patchRebase({ signingWarning: info.effective.signCommits });
  } catch {
    /* best-effort */
  }
}

export function setRebaseBase(base: string): void {
  patchRebase({ base });
}

export function checkRebaseBase(): void {
  void loadRebasePreflight();
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export async function proposeRebasePlan(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const { base, shas } = store.get().rebase;
  patchRebase({ planLoading: true, planError: null, plan: null, applyError: null });
  try {
    const plan = await invoke('ai.rebase.plan', repo.path, base, shas);
    patchRebase({ plan, planLoading: false });
  } catch (err) {
    patchRebase({ planLoading: false, planError: errorMessage(err) });
  }
}

export function reproposeRebasePlan(): void {
  patchRebase({ plan: null, planError: null, applyError: null });
  void loadRebasePreflight();
}

export function cancelRebasePropose(): void {
  void invoke('ai.cancel').catch(() => undefined);
}

export function closeRebaseDialog(): void {
  if (store.get().rebase.applying) return; // non-dismissible while applying
  closeDialog();
}

// ---------------------------------------------------------------------------
// Editing the plan
// ---------------------------------------------------------------------------

function withPlan(fn: (plan: RebasePlan) => RebasePlan): void {
  patchRebase((s) => (s.plan ? { plan: fn(s.plan) } : {}));
}

/** Earlier pick/reword rows a given row may squash into (the only choices the UI offers, so an invalid squash target can never be constructed). */
export function validSquashTargets(plan: RebasePlan, sha: string): RebasePlanRow[] {
  const idx = plan.rows.findIndex((r) => r.sha === sha);
  if (idx < 0) return [];
  return plan.rows.slice(0, idx).filter((r) => r.action === 'pick' || r.action === 'reword');
}

export function setRebaseRowAction(sha: string, action: RebasePlanAction): void {
  withPlan((plan) => ({
    ...plan,
    rows: plan.rows.map((r) => {
      if (r.sha !== sha) return r;
      if (action === 'squash') {
        const targets = validSquashTargets(plan, sha);
        return { ...r, action, squashInto: targets[targets.length - 1]?.sha ?? null };
      }
      return { ...r, action, squashInto: null };
    }),
  }));
}

export function setRebaseSquashTarget(sha: string, targetSha: string): void {
  withPlan((plan) => ({ ...plan, rows: plan.rows.map((r) => (r.sha === sha ? { ...r, squashInto: targetSha } : r)) }));
}

export function setRebaseRowMessage(sha: string, message: string): void {
  withPlan((plan) => ({ ...plan, rows: plan.rows.map((r) => (r.sha === sha ? { ...r, message } : r)) }));
}

export function resetRebaseRow(sha: string): void {
  withPlan((plan) => ({ ...plan, rows: plan.rows.map((r) => (r.sha === sha ? { ...r, action: 'pick', squashInto: null, message: r.originalMessage } : r)) }));
}

export function resetRebasePlan(): void {
  withPlan((plan) => ({ ...plan, rows: plan.rows.map((r) => ({ ...r, action: 'pick', squashInto: null, message: r.originalMessage })) }));
}

export function reorderRebaseRow(fromIndex: number, toIndex: number): void {
  withPlan((plan) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= plan.rows.length || toIndex >= plan.rows.length) return plan;
    const rows = [...plan.rows];
    const [moved] = rows.splice(fromIndex, 1);
    rows.splice(toIndex, 0, moved);
    // Any row that squashed into something now positioned after it becomes invalid; drop back to pick.
    const indexOf = new Map(rows.map((r, i) => [r.sha, i]));
    const repaired = rows.map((r) => {
      if (r.action !== 'squash' || !r.squashInto) return r;
      const targetIdx = indexOf.get(r.squashInto);
      const target = rows.find((x) => x.sha === r.squashInto);
      const ok = targetIdx !== undefined && target && (target.action === 'pick' || target.action === 'reword') && targetIdx < (indexOf.get(r.sha) ?? -1);
      return ok ? r : { ...r, action: 'pick' as const, squashInto: null };
    });
    return { ...plan, rows: repaired };
  });
}

/** A plan with every row pick, unchanged and in order needs nothing applied — the model itself may also report this via `alreadyTidy`, but user edits can restore it too. */
export function rebaseAlreadyTidy(plan: RebasePlan | null): boolean {
  if (!plan) return false;
  return plan.rows.every((r) => r.action === 'pick' && r.message === r.originalMessage);
}

export function canApplyRebasePlan(plan: RebasePlan | null): boolean {
  if (!plan || !plan.rows.length) return false;
  if (rebaseAlreadyTidy(plan)) return false;
  return plan.rows.every((r) => r.action !== 'reword' || r.message.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Apply / undo
// ---------------------------------------------------------------------------

export async function applyRebasePlan(): Promise<void> {
  const repo = store.get().currentRepo;
  const plan = store.get().rebase.plan;
  if (!repo || !plan || !canApplyRebasePlan(plan)) return;
  patchRebase({ applying: true, applyProgress: null, applyError: null });
  try {
    const outcome = await invoke('ai.rebase.apply', repo.path, plan);
    patchRebase({ applying: false, applyProgress: null });
    if (outcome.status === 'conflicts') {
      closeDialog();
      await refreshAll();
      openDialog({ kind: 'conflicts' });
      return;
    }
    closeDialog();
    await refreshAll();
    patchRebase({ lastApplied: { startSha: plan.startSha } });
    const pushedRewritten = plan.rows.some((r) => r.pushed);
    showToast(
      {
        kind: 'success',
        title: 'Branch tidied',
        message: pushedRewritten ? 'Some rewritten commits were already pushed; a force push with lease will be needed.' : undefined,
        action: { label: 'Undo', onClick: () => void undoRebasePlan() },
      },
      UNDO_WINDOW_MS,
    );
  } catch (err) {
    patchRebase({ applying: false, applyError: errorMessage(err) });
    await refreshAll();
  }
}

export function handleRebaseProgress(e: RebaseApplyProgress): void {
  if (store.get().rebase.plan?.id !== e.planId) return;
  patchRebase({ applyProgress: e });
}

export async function undoRebasePlan(): Promise<void> {
  const repo = store.get().currentRepo;
  const applied = store.get().rebase.lastApplied;
  if (!repo || !applied) return;
  try {
    await invoke('ai.rebase.undo', repo.path, applied.startSha);
    patchRebase({ lastApplied: null });
    await refreshAll();
    showToast({ kind: 'success', title: 'Tidy undone' });
  } catch (err) {
    showError('Could not undo the tidy', err);
  }
}
