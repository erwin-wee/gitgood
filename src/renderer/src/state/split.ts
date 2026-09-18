import type { SplitApplyProgress, SplitPlan, SplitPlanCommit } from '@shared/types';
import { SPLIT_SUMMARY_PLACEHOLDER } from '@shared/util';
import { errorInfo, errorMessage, invoke } from '../api';
import { includedFiles, refreshAll, showError } from './actions';
import { closeDialog, initialSplit, openDialog, patchSplit, showToast, store } from './store';

/** "Not included" is modelled as the plan's own `unassigned` bucket, which starts as whatever the model left out and grows as the user drags hunks/files out of a commit or deletes a card. */
const UNASSIGNED = 'unassigned' as const;
type SplitTarget = string | typeof UNASSIGNED;

// ---------------------------------------------------------------------------
// Entry point gating
// ---------------------------------------------------------------------------

/** Hidden unless the provider is enabled, a repository is open, no merge/cherry-pick/revert is in progress, and Amend is not checked (per spec: these three conditions hide the entry point entirely rather than merely disabling it). */
export function splitEntryVisible(): boolean {
  const s = store.get();
  return !!s.currentRepo && s.settings?.ai.provider !== 'disabled' && s.status?.operation.kind !== 'merge' && s.status?.operation.kind !== 'cherry-pick' && s.status?.operation.kind !== 'revert' && !s.changes.amend;
}

/**
 * Visible but not actionable below two hunks. There is no cheap way to
 * count hunks client-side without diffing every included file, so this uses
 * the included file count as a conservative proxy: two or more included
 * files always means two or more hunks, so this never wrongly enables the
 * action; a single file with several hunks is a known false negative here
 * (documented), resolved authoritatively by the real hunk count the
 * pre-flight card shows before Propose is ever enabled.
 */
export function splitEntryEnabled(): boolean {
  return splitEntryVisible() && includedFiles().length >= 2;
}

// ---------------------------------------------------------------------------
// Pre-flight and proposal
// ---------------------------------------------------------------------------

export function openSplitDialog(): void {
  if (!splitEntryVisible()) return;
  patchSplit({ ...initialSplit });
  openDialog({ kind: 'split-plan' });
  void loadSplitPreflight();
}

export async function loadSplitPreflight(): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const files = includedFiles().map((f) => f.path);
  patchSplit({ preflight: null, preflightLoading: true, preflightError: null });
  try {
    const preflight = await invoke('ai.split.preflight', repo.path, files);
    patchSplit({ preflight, preflightLoading: false });
  } catch (err) {
    patchSplit({ preflightLoading: false, preflightError: errorMessage(err) });
  }
}

export async function proposeSplit(fileOnly = false): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const files = includedFiles().map((f) => f.path);
  patchSplit({ planLoading: true, planError: null, plan: null, fileOnly, applyError: null });
  try {
    const plan = await invoke('ai.split.plan', repo.path, files, fileOnly);
    patchSplit({ plan, planLoading: false });
  } catch (err) {
    patchSplit({ planLoading: false, planError: errorMessage(err) });
  }
}

/** Discards the current plan and returns to the pre-flight card, e.g. after Apply refused on staleness. */
export function reproposeSplit(): void {
  patchSplit({ plan: null, planError: null, applyError: null });
  void loadSplitPreflight();
}

export function cancelSplitPropose(): void {
  void invoke('ai.cancel').catch(() => undefined);
}

export function closeSplitDialog(): void {
  if (store.get().split.applying) return; // non-dismissible while applying
  closeDialog();
}

// ---------------------------------------------------------------------------
// Editing the plan
// ---------------------------------------------------------------------------

function withPlan(fn: (plan: SplitPlan) => SplitPlan): void {
  patchSplit((s) => (s.plan ? { plan: fn(s.plan) } : {}));
}

/** Removes a hunk id from every commit's hunkIds and from `unassigned`, wherever it currently is. */
function pullHunk(plan: SplitPlan, hunkId: string): SplitPlan {
  return { ...plan, commits: plan.commits.map((c) => ({ ...c, hunkIds: c.hunkIds.filter((id) => id !== hunkId) })), unassigned: plan.unassigned.filter((id) => id !== hunkId) };
}

function pullWholeFile(plan: SplitPlan, path: string): SplitPlan {
  return { ...plan, commits: plan.commits.map((c) => ({ ...c, wholeFiles: c.wholeFiles.filter((p) => p !== path) })), unassigned: plan.unassigned.filter((p) => p !== path) };
}

export function moveHunkTo(hunkId: string, target: SplitTarget): void {
  withPlan((plan) => {
    const pulled = pullHunk(plan, hunkId);
    if (target === UNASSIGNED) return { ...pulled, unassigned: [...pulled.unassigned, hunkId] };
    return { ...pulled, commits: pulled.commits.map((c) => (c.id === target ? { ...c, hunkIds: [...c.hunkIds, hunkId] } : c)) };
  });
}

export function moveWholeFileTo(path: string, target: SplitTarget): void {
  withPlan((plan) => {
    const pulled = pullWholeFile(plan, path);
    if (target === UNASSIGNED) return { ...pulled, unassigned: [...pulled.unassigned, path] };
    return { ...pulled, commits: pulled.commits.map((c) => (c.id === target ? { ...c, wholeFiles: [...c.wholeFiles, path] } : c)) };
  });
}

export function selectSplitHunk(hunkId: string | null): void {
  patchSplit({ selectedHunkId: hunkId });
}

export function reorderCommit(fromIndex: number, toIndex: number): void {
  withPlan((plan) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= plan.commits.length || toIndex >= plan.commits.length) return plan;
    const commits = [...plan.commits];
    const [moved] = commits.splice(fromIndex, 1);
    commits.splice(toIndex, 0, moved);
    return { ...plan, commits };
  });
}

/** Merges `sourceId`'s hunks/whole files into `targetId` (which keeps its own summary/description/rationale) and removes the source card. */
export function mergeCommitInto(sourceId: string, targetId: string): void {
  if (sourceId === targetId) return;
  withPlan((plan) => {
    const source = plan.commits.find((c) => c.id === sourceId);
    if (!source) return plan;
    const commits = plan.commits
      .filter((c) => c.id !== sourceId)
      .map((c) => (c.id === targetId ? { ...c, hunkIds: [...c.hunkIds, ...source.hunkIds], wholeFiles: [...c.wholeFiles, ...source.wholeFiles] } : c));
    return { ...plan, commits };
  });
}

export function updateCommitMessage(commitId: string, patch: Partial<Pick<SplitPlanCommit, 'summary' | 'description'>>): void {
  withPlan((plan) => ({ ...plan, commits: plan.commits.map((c) => (c.id === commitId ? { ...c, ...patch } : c)) }));
}

/** Deletes a commit card; its hunks and whole files move to "Not included" rather than being dropped. */
export function deleteCommit(commitId: string): void {
  withPlan((plan) => {
    const target = plan.commits.find((c) => c.id === commitId);
    if (!target) return plan;
    return { ...plan, commits: plan.commits.filter((c) => c.id !== commitId), unassigned: [...plan.unassigned, ...target.hunkIds, ...target.wholeFiles] };
  });
}

// ---------------------------------------------------------------------------
// Apply / undo
// ---------------------------------------------------------------------------

/** A plan with zero or one commit needs no splitting; the dialog offers the normal commit flow instead of Apply. */
export function splitAlreadyCoherent(plan: SplitPlan | null): boolean {
  return !!plan && plan.commits.length <= 1;
}

/** Apply stays disabled until every commit has a real summary and there is at least one commit to create. */
export function canApplySplit(plan: SplitPlan | null): boolean {
  if (!plan || !plan.commits.length) return false;
  return plan.commits.every((c) => c.summary.trim() && c.summary !== SPLIT_SUMMARY_PLACEHOLDER);
}

export async function applySplit(): Promise<void> {
  const repo = store.get().currentRepo;
  const plan = store.get().split.plan;
  if (!repo || !plan || !canApplySplit(plan)) return;
  patchSplit({ applying: true, applyProgress: null, applyError: null });
  try {
    const result = await invoke('ai.split.apply', repo.path, plan);
    patchSplit({ applying: false, applyProgress: null, lastApplied: { startSha: plan.startSha, headSha: result.shas[result.shas.length - 1] ?? plan.startSha, commitCount: result.shas.length } });
    closeDialog();
    await refreshAll();
    showToast(
      { kind: 'success', title: `Created ${result.shas.length} commit${result.shas.length === 1 ? '' : 's'}`, action: { label: 'Undo all', onClick: () => void undoSplit() }, sticky: true },
      15000,
    );
  } catch (err) {
    const info = errorInfo(err);
    patchSplit({ applying: false, applyError: { message: errorMessage(err), stale: info.code === 'split-stale' } });
    await refreshAll();
  }
}

export function handleSplitProgress(e: SplitApplyProgress): void {
  if (store.get().split.plan?.id !== e.planId) return;
  patchSplit({ applyProgress: e });
}

/**
 * Cheap, local-status-only approximation of "offered only while startSha is
 * still an ancestor of HEAD and nothing has been pushed since": true
 * whenever nothing else has moved HEAD locally (branch.sha still matches
 * what apply produced), so it never wrongly refuses a repository with no
 * upstream at all (branch.ahead is meaningless without one). It cannot see
 * whether these exact commits reached the upstream — `SplitterService.undo`
 * (src/main/ai/splitter.ts) is the authoritative check for that and refuses
 * with a clear message when it has.
 */
export async function canUndoSplit(): Promise<boolean> {
  const s = store.get();
  const repo = s.currentRepo;
  const applied = s.split.lastApplied;
  if (!repo || !applied || !s.status) return false;
  if (s.status.branch.sha !== applied.headSha) return false;
  if (s.status.branch.upstream && s.status.branch.ahead < applied.commitCount) return false;
  try {
    return await invoke('git.isAncestor', repo.path, applied.startSha, s.status.branch.sha ?? applied.headSha);
  } catch {
    return false;
  }
}

export async function undoSplit(): Promise<void> {
  const repo = store.get().currentRepo;
  const applied = store.get().split.lastApplied;
  if (!repo || !applied) return;
  // Cheap client-side check first (catches the common case of further local commits without a round trip); the server repeats the ancestry check and additionally refuses once any of these commits reached the upstream, which cannot be judged from local status alone.
  if (!(await canUndoSplit())) {
    showToast({ kind: 'info', title: 'Undo is no longer available', message: 'The repository changed since this split was applied.' });
    patchSplit({ lastApplied: null });
    return;
  }
  try {
    await invoke('ai.split.undo', repo.path, applied.startSha);
    patchSplit({ lastApplied: null });
    await refreshAll();
    showToast({ kind: 'success', title: 'Split undone', message: 'The commits were removed; your changes are back in the working tree.' });
  } catch (err) {
    showError('Could not undo the split', err);
  }
}
