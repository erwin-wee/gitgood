import type { CommitOptions, RepoPrefs, RepositoryInfo, WorkingFile } from '@shared/types';
import { aiEnabled } from '@shared/ai-model';
import { buildStagePatch } from '@shared/diff/patch';
import { errorInfo, invoke } from '../../api';
import { closeDialog, openDialog, patchChanges, patchDiff, patchHistory, showToast, store, type ChangesState } from '../store';
import { runPrecommitReviewForGate } from '../precommitReview';
import { showError } from './core';
import { refreshAll } from './repo';
import { loadHistory, setView } from './view';

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export function includedFiles(): WorkingFile[] {
  const s = store.get();
  return (s.status?.files ?? []).filter((f) => !s.changes.excluded.includes(f.path));
}

export async function commit(): Promise<void> {
  const s = store.get();
  const gateOn = s.settings?.ai.reviewBeforeCommit && aiEnabled(s.settings, s.currentRepo) && !s.changes.committing;
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
      signoff: repo.signoff,
      noVerify: s.changes.noVerify,
    };
    const sha = await invoke('git.commit', repo.path, opts);
    patchChanges({ summary: '', description: '', amend: false, committing: false, noVerify: false, partial: {}, excluded: [] });
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

/** Prefills an empty, non-amend commit form from `commit.template`; never overwrites anything the user (or an AI draft) already typed, and skips merges (git ignores the template there). */
export async function prefillCommitTemplate(): Promise<void> {
  const repo = store.get().currentRepo;
  const empty = (c: ChangesState) => !c.amend && !c.summary && !c.description;
  const idle = () => empty(store.get().changes) && store.get().status?.operation.kind === 'none';
  if (!repo || !idle()) return;
  const template = await invoke('repo.commitTemplate', repo.path).catch(() => null);
  if (template && store.get().currentRepo?.path === repo.path && idle()) patchChanges({ summary: template.summary, description: template.description });
}

/** Machine-local per-repository prefs: pin, custom group, commit sign-off, GitHub account. */
export async function setRepoPrefs(repo: RepositoryInfo, prefs: RepoPrefs): Promise<void> {
  try {
    await invoke('repos.setPrefs', repo.id, prefs);
  } catch (err) {
    showError('Could not save repository settings', err);
  }
}

/** Machine-local "Disable AI for this repository" toggle; the list refreshes through `repos.changed`. */
export async function setRepoAiDisabled(repo: RepositoryInfo, disabled: boolean): Promise<void> {
  try {
    await invoke('repos.setAiDisabled', repo.id, disabled);
  } catch (err) {
    showError('Could not save repository settings', err);
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
    if (msg.skipped.length) showToast({ kind: 'info', title: 'Left out of the AI request', message: msg.skipped.join('\n') }, 8000);
  } catch (err) {
    showError('Could not generate a commit message', err);
  } finally {
    store.set({ aiCommitBusy: false });
  }
}
