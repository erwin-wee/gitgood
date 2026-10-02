import type { ErrorFix, ExplainSource, ExplainTarget, GitErrorInfo, RepositoryInfo, RepositoryStatus } from '@shared/types';
import { aiEnabled } from '@shared/ai-model';
import { EXPLAIN_FOLLOWUP_LIMIT } from '@shared/types';
import { explanationToMarkdown } from '@shared/util';
import { ApiError, errorMessage, invoke } from '../../api';
import { closeAllDialogs, initialErrorExplain, initialExplain, openDialog, patchDiff, patchErrorExplain, patchExplain, saveExplainPanelWidth, showToast, store, type DialogState } from '../store';
import { showError } from './core';
import { refreshStatus } from './repo';
import { abortOperation, continueOperation } from './conflicts';
import { selectCommitFile, selectWorkingFile } from './view';
import { fetchRemote, openInShellAt, pull, push } from './branches';
import { requestDiscard, selectStashViewFile, stashAll } from './stash';
import { copyToClipboard } from './app';

// ---------------------------------------------------------------------------
// AI diff explanation
// ---------------------------------------------------------------------------

/** True when the AI provider is enabled and the current repository has not opted out; entry points across the app are hidden (not disabled) when it is not. */
export function aiExplainAvailable(): boolean {
  return aiEnabled(store.get().settings, store.get().currentRepo);
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
  void invoke('ai.cancel', 'explain');
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

/** Clicking an explanation reference: switches to that file in the active tab's file list when needed, then asks the text diff to scroll to the line once it is showing that file. */
export function focusExplainReference(path: string, line: number | null): void {
  const s = store.get();
  if (s.view === 'history' && s.history.selectedFile !== path && (s.history.details?.files.some((f) => f.path === path) ?? false)) selectCommitFile(path);
  else if (s.view === 'changes' && s.changes.selectedPaths[0] !== path && (s.status?.files.some((f) => f.path === path) ?? false)) selectWorkingFile(path);
  else if (s.view === 'stashes' && s.stashesView.selectedFile !== path && s.stashesView.files.some((f) => f.path === path)) selectStashViewFile(path);
  // Set after the switch: loadDiff clears revealLine when the shown file changes.
  if (line !== null) patchDiff({ revealLine: line });
}

export function clearDiffReveal(): void {
  patchDiff({ revealLine: null });
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
  void invoke('ai.cancel', 'errorExplain');
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
