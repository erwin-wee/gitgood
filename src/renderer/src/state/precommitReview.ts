import type { ReviewFinding, WorktreeReviewOptions } from '@shared/types';
import { buildStagePatch } from '@shared/diff/patch';
import { isImagePath } from '@shared/util';
import { errorMessage, invoke } from '../api';
import { includedFiles, loadDiff, refreshStatus, selectWorkingFile, showError } from './actions';
import { initialPrecommitReview, openDialog, patchPrecommitReview, showToast, store, type WorktreeReviewRun } from './store';

// ---------------------------------------------------------------------------
// Pre-commit AI review: reviews the exact patch the pending commit would
// apply, shown inline in the Changes tab (findings strip + diff gutter
// markers) rather than in the separate PR/branch review view.
// ---------------------------------------------------------------------------

export function precommitReviewAvailable(): boolean {
  const s = store.get();
  return !!s.currentRepo && s.settings?.ai.provider !== 'disabled';
}

const LOCKFILE_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'go.sum', 'composer.lock']);

/** Best-effort client-side guess at whether a path is worth sending to the model, so the "Review changes" action can refuse instantly for an all-binary selection without a round trip. The server applies the authoritative skip rules once a review actually runs. */
function looksReviewableClientSide(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (isImagePath(path)) return false;
  if (LOCKFILE_NAMES.has(base)) return false;
  if (/\.(pdf|zip|gz|tgz|jar|exe|dll|so|dylib|mp[34]|mov|wasm|woff2?|ttf|eot|otf|ico|bmp|tiff?|avif)$/i.test(base)) return false;
  return true;
}

async function buildWorktreeReviewOptions(only?: string[]): Promise<WorktreeReviewOptions | null> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.status) return null;
  const files = includedFiles();
  if (!files.length && !s.changes.amend) return null;
  const partialPatches: Record<string, string> = {};
  for (const [path, keys] of Object.entries(s.changes.partial)) {
    if (!files.some((f) => f.path === path)) continue;
    const diff = await invoke('repo.diff.working', repo.path, path, { hideWhitespace: false });
    if (diff.kind !== 'text') continue;
    const set = new Set(keys);
    const patch = buildStagePatch({ oldPath: diff.oldPath, newPath: diff.newPath, hunks: diff.hunks }, (h, l) => set.has(`${h}:${l}`));
    if (patch) partialPatches[path] = patch;
  }
  return { files: files.map((f) => f.path), partialPatches, summary: s.changes.summary, description: s.changes.description, amend: s.changes.amend, only };
}

/** Runs (or re-runs) the pre-commit review; `only` restricts which files are actually sent, carrying over the rest from the current run. Returns null when there was nothing to review or the run could not be started. */
async function runPrecommitReview(only?: string[]): Promise<WorktreeReviewRun | null> {
  const repo = store.get().currentRepo;
  const base = await buildWorktreeReviewOptions(only);
  if (!repo || !base) return null;
  const previous = store.get().precommitReview.run;
  patchPrecommitReview({ running: true, progress: null });
  try {
    const opts: WorktreeReviewOptions = { ...base, rereviewOf: only?.length && previous ? previous.id : undefined };
    const run = (await invoke('ai.review.startWorktree', repo.path, opts)) as WorktreeReviewRun;
    patchPrecommitReview({ run, running: false, progress: null, stalePaths: [], activeFindingId: null, expanded: true });
    return run;
  } catch (err) {
    patchPrecommitReview({ running: false, progress: null });
    throw err;
  }
}

/** The "Review changes" action in the commit form. */
export async function reviewChangesBeforeCommit(): Promise<void> {
  if (!precommitReviewAvailable()) {
    showToast({ kind: 'info', title: 'AI features are turned off', message: 'Enable a provider under Options → AI.', action: { label: 'Options', onClick: () => openDialog({ kind: 'settings', tab: 'ai' }) } });
    return;
  }
  const files = includedFiles();
  if (!files.length) {
    showToast({ kind: 'info', title: 'Nothing to review', message: 'Include at least one file in the commit first.' });
    return;
  }
  if (!files.some((f) => looksReviewableClientSide(f.path))) {
    showToast({ kind: 'info', title: 'Nothing to review', message: 'Every included file is binary, an image, or a submodule.' });
    return;
  }
  try {
    const run = await runPrecommitReview();
    if (!run) return;
    const live = run.findings.filter((f) => !f.dismissed);
    if (run.cancelled) showToast({ kind: 'warning', title: 'Review cancelled', message: live.length ? `${live.length} finding${live.length === 1 ? '' : 's'} collected before cancelling.` : undefined });
    else if (run.error) showToast({ kind: 'error', title: 'Review incomplete', message: run.error }, 12000);
    else showToast({ kind: live.some((f) => f.severity === 'blocker') ? 'warning' : 'success', title: live.length ? `${live.length} finding${live.length === 1 ? '' : 's'}` : `No issues found in ${run.files.filter((f) => f.status === 'reviewed').length} files`, message: run.summary.slice(0, 160) }, 10000);
  } catch (err) {
    showError('AI review failed', err);
  }
}

/** Used by the "Review before every commit" gate: runs the review silently (no toasts) and never throws, so it can never block the commit. */
export async function runPrecommitReviewForGate(): Promise<WorktreeReviewRun | null> {
  try {
    return await runPrecommitReview();
  } catch {
    return null;
  }
}

export async function rereviewStalePrecommitFindings(): Promise<void> {
  const stale = store.get().precommitReview.stalePaths;
  if (!stale.length) return;
  try {
    await runPrecommitReview(stale);
  } catch (err) {
    showError('AI review failed', err);
  }
}

export function cancelPrecommitReview(): void {
  void invoke('ai.cancel').catch(() => undefined);
}

export function togglePrecommitReviewStrip(): void {
  patchPrecommitReview((r) => ({ expanded: !r.expanded }));
}

export function setActivePrecommitFinding(id: string | null): void {
  patchPrecommitReview({ activeFindingId: id });
}

/** Selects the finding's file and scrolls the diff to it, opening its card (mirrors focusFinding in state/review.ts, but for the inline Changes-tab diff pane). */
export function focusPrecommitFinding(finding: ReviewFinding): void {
  const r = store.get().precommitReview;
  selectWorkingFile(finding.path);
  patchPrecommitReview({ activeFindingId: r.activeFindingId === finding.id && store.get().changes.selectedPaths[0] === finding.path ? null : finding.id });
}

export async function dismissPrecommitFinding(finding: ReviewFinding, dismissed = true): Promise<void> {
  const s = store.get();
  const run = s.precommitReview.run;
  if (!run || !s.currentRepo) return;
  patchPrecommitReview({ run: { ...run, findings: run.findings.map((f) => (f.id === finding.id ? { ...f, dismissed } : f)) }, activeFindingId: dismissed && s.precommitReview.activeFindingId === finding.id ? null : s.precommitReview.activeFindingId });
  try {
    await invoke('ai.review.dismiss', s.currentRepo.path, run.id, finding.id, dismissed);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not save the dismissal', message: errorMessage(err) });
  }
}

/** Writes the finding's suggestion into the working tree; refused server-side when the file changed since the review or is partially selected. */
export async function applyPrecommitSuggestion(finding: ReviewFinding): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  const run = s.precommitReview.run;
  if (!repo || !run) return;
  try {
    await invoke('ai.review.applySuggestion', repo.path, run.id, finding.id);
    showToast({ kind: 'success', title: 'Suggestion applied', message: finding.path });
    await dismissPrecommitFinding(finding, true); // the suggestion is now in the file; stop flagging it
    await refreshStatus();
    await refreshPrecommitStaleness();
    if (store.get().changes.selectedPaths[0] === finding.path) void loadDiff(true);
  } catch (err) {
    showError('Could not apply the suggestion', err);
  }
}

/** Recomputes which reviewed files' content has changed since the run, called after anything that could have touched the working tree (repo.changed, applying a suggestion). */
export async function refreshPrecommitStaleness(): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  const run = s.precommitReview.run;
  if (!repo || !run) return;
  try {
    const stale = await invoke('ai.review.worktreeStale', repo.path, run.id);
    if (store.get().precommitReview.run?.id === run.id) patchPrecommitReview({ stalePaths: stale });
  } catch {
    /* best-effort */
  }
}

/** Clears the current run when the set of included files changed (a file was added or removed from the commit), per spec; editing a file's content is handled as staleness instead, not clearing. */
export function syncPrecommitReviewSelection(): void {
  const run = store.get().precommitReview.run;
  if (!run) return;
  const current = new Set(includedFiles().map((f) => f.path));
  const runPaths = new Set(run.target.paths);
  const changed = current.size !== runPaths.size || [...current].some((p) => !runPaths.has(p));
  if (changed) patchPrecommitReview({ ...initialPrecommitReview, expanded: store.get().precommitReview.expanded });
}

export function handlePrecommitReviewProgress(e: import('@shared/types').AiReviewProgressEvent): void {
  patchPrecommitReview({ progress: e });
}
