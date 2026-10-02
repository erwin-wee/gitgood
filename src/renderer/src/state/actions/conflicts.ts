import type { ConflictResolutionResult } from '@shared/types';
import { errorMessage, invoke } from '../../api';
import { closeAllDialogs, closeDialog, NO_CONFLICT_EXAMPLES, openDialog, patchStashesView, showToast, store } from '../store';
import { runOperation, showError } from './core';
import { refreshStatus } from './repo';
import { loadDiff, loadHistory } from './view';

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
  let command: string | null = info.command;
  // Re-prompt with the new command whenever the file changed while the dialog was open (repo.trustConfig refuses a grant for a command the user was not shown).
  while (command) {
    const shown: string = command;
    const accept = await new Promise<boolean>((resolvePromise) => {
      openDialog({ kind: 'trust-repo-check', repoPath, command: shown, onDecision: (a) => { closeDialog(); resolvePromise(a); } });
    });
    try {
      const result = await invoke('repo.trustConfig', repoPath, accept, shown);
      command = result.ok ? null : result.command;
    } catch {
      return;
    }
  }
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
    const [branches, defaultBranch, stack] = await Promise.all([invoke('repo.branches', repo.path), invoke('repo.defaultBranch', repo.path), invoke('repo.stack', repo.path)]);
    if (store.get().currentRepo?.path !== repo.path) return;
    store.set({ branches, defaultBranch, stack });
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
