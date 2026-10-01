import type { BlameHunk, BlameResult, FileDiff, HistoryQuery } from '@shared/types';
import { EMPTY_HISTORY_QUERY, ZERO_SHA } from '@shared/types';
import { buildFileViewDiff } from '@shared/diff/parse';
import { checkRegexBrackets, formatHistoryQuery, isEmptyHistoryQuery, parseHistoryQuery } from '@shared/util';
import { ApiError, errorMessage, invoke } from '../../api';
import { openDialog, patchChanges, patchDiff, patchHistory, showToast, store, type View } from '../store';
import { syncPrecommitReviewSelection } from '../precommitReview';
import { showError } from './core';
import { refreshStatus } from './repo';
import { refreshStashes } from './conflicts';
import { loadStashesView } from './stash';
import { captureConflictOriginal } from './shared';

const HISTORY_PAGE = 100;

// ---------------------------------------------------------------------------
// View & selection
// ---------------------------------------------------------------------------

export function setView(view: View): void {
  if (store.get().view === view) return;
  store.set({ view, phonePane: 'list' });
  if (view === 'history') {
    const h = store.get().history;
    if (!h.commits.length || h.stale) void loadHistory(true);
    else if (!h.selectedShas.length) selectCommit(h.commits[0].sha);
  } else if (view === 'stashes') {
    void loadStashesView();
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
  patchChanges({ selectedPaths: selected });
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
  syncPrecommitReviewSelection();
}

export function setAllIncluded(included: boolean): void {
  const s = store.get();
  patchChanges({ excluded: included ? [] : (s.status?.files ?? []).map((f) => f.path), partial: {} });
  patchDiff({ selectedLines: null });
  syncPrecommitReviewSelection();
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
  patchHistory({ selectedShas: selected, detailsError: null, details: selected.length === 1 && s.history.details?.commit.sha === selected[0] ? s.history.details : null, selectedFile: selected.length === 1 && s.history.details?.commit.sha === selected[0] ? s.history.selectedFile : null });
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
  patchHistory({ detailsLoading: true, detailsError: null });
  try {
    const details = await invoke('repo.commit.details', repo.path, sha);
    const h = store.get().history;
    if (h.selectedShas[0] !== sha || h.selectedShas.length !== 1) {
      patchHistory({ detailsLoading: false });
      return;
    }
    // A content/regex search narrows the file list to files whose diff actually matched.
    let matchingFiles: string[] | null = null;
    if (h.query.content || h.query.diffRegex) {
      try {
        matchingFiles = await invoke('repo.history.matchingFiles', repo.path, sha, h.query);
      } catch {
        matchingFiles = null;
      }
      if (store.get().history.selectedShas[0] !== sha || store.get().history.selectedShas.length !== 1) {
        patchHistory({ detailsLoading: false });
        return;
      }
    }
    const visibleFiles = matchingFiles ? details.files.filter((f) => matchingFiles!.includes(f.path)) : details.files;
    // In file-history mode, prefer the tracked file's name *at this commit* (it may differ across renames).
    const pathAtCommit = h.path ? h.pathHistory?.find((e) => e.sha === sha)?.path ?? h.path : null;
    const preferred = pathAtCommit && visibleFiles.some((f) => f.path === pathAtCommit) ? pathAtCommit : null;
    const selectedFile = preferred ?? (h.selectedFile && visibleFiles.some((f) => f.path === h.selectedFile) ? h.selectedFile : visibleFiles[0]?.path ?? null);
    patchHistory({ details, detailsLoading: false, selectedFile, matchingFiles, detailsError: null });
    void loadDiff();
  } catch (err) {
    patchHistory({ detailsLoading: false, detailsError: errorMessage(err) });
    showToast({ kind: 'error', title: 'Could not load commit', message: errorMessage(err) });
  }
}

/** True while any text/structured filter is active (drag-to-reorder and the legacy "search" positional args are disabled while this is true). */
export function historyFilterActive(h = store.get().history): boolean {
  return !!h.search.trim();
}

/**
 * True while the history list is showing a subset of the branch, so
 * drag-to-reorder must be off: adjacent rows are not adjacent commits, and
 * dropping one onto the next would reorder across everything in between.
 * Broader than `historyFilterActive`, which only covers the text filter —
 * file-history mode sets `path` with an empty `search`.
 */
export function historyReorderDisabled(h = store.get().history): boolean {
  return historyFilterActive(h) || !!h.path;
}

let slowSearchTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadHistory(reset: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const h = store.get().history;
  if (h.loading && !reset) return;
  if (slowSearchTimer) clearTimeout(slowSearchTimer);
  patchHistory({ loading: true, slowSearch: false, ...(reset ? { error: null } : {}) });
  slowSearchTimer = setTimeout(() => patchHistory({ slowSearch: true }), 5000);
  try {
    const skip = reset ? 0 : h.commits.length;
    // Later pages keep the order the list was started with; only a reset re-reads the setting and the filter state.
    const graph = reset ? (store.get().settings?.historyGraph ?? false) && !historyFilterActive(h) && !h.path : h.graph;
    const page = await invoke('repo.history', repo.path, { ref: null, skip, limit: HISTORY_PAGE, path: h.path, search: h.freeText.trim() || null, follow: !!h.path, query: isEmptyHistoryQuery(h.query) ? null : h.query, verifySignatures: store.get().settings?.historyVerifySignatures ?? false, graph });
    if (store.get().currentRepo?.path !== repo.path) return;
    const commits = reset ? page.commits : [...h.commits, ...page.commits];
    const stillSelected = store.get().history.selectedShas.filter((sha) => commits.some((c) => c.sha === sha));
    patchHistory({ commits, graph, hasMore: page.hasMore, loading: false, slowSearch: false, error: null, selectedShas: stillSelected, details: stillSelected.length === 1 ? store.get().history.details : null, stale: store.get().history.stale && !(reset && h.stale) });
    if (store.get().view === 'history' && stillSelected.length === 0 && commits.length) selectCommit(commits[0].sha);
    else if (stillSelected.length === 1 && reset) void loadCommitDetails(stillSelected[0]);
  } catch (err) {
    // A newer history request superseded this one (the main process aborts the older git run); the newer call owns the loading state.
    if (err instanceof ApiError && err.code === 'cancelled') return;
    patchHistory({ loading: false, slowSearch: false, error: errorMessage(err) });
    showToast({ kind: 'error', title: 'Could not load history', message: errorMessage(err) });
  } finally {
    if (slowSearchTimer) {
      clearTimeout(slowSearchTimer);
      slowSearchTimer = null;
    }
  }
}

/** Validates a `regex:` filter client-side (balanced brackets/parens only; git reports anything subtler once it runs). */
function validateHistoryQuery(query: HistoryQuery): string | null {
  return query.diffRegex ? checkRegexBrackets(query.diffRegex) : null;
}

/** Parses the search box text, updates the popover-synced query state, and (debounced) reloads history. Cancels the previous in-flight search (the main process aborts it once a new `repo.history` call arrives). */
export function setHistorySearch(search: string): void {
  const { query, freeText } = parseHistoryQuery(search);
  const queryError = validateHistoryQuery(query);
  patchHistory({ search, query, freeText, queryError });
  if (searchTimer) clearTimeout(searchTimer);
  if (queryError) return; // inline error only; never runs git or shows a loading state
  searchTimer = setTimeout(() => void loadHistory(true), 400);
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/** Applies the filter popover's structured query, keeping the text box in sync (round-trips through formatHistoryQuery). */
export function setHistoryQuery(query: HistoryQuery): void {
  setHistorySearch(formatHistoryQuery(query, store.get().history.freeText));
}

export function clearHistoryFilter(): void {
  setHistorySearch('');
}

/** "Search history for selection": prefills a `content:` filter from selected diff text and switches to the History tab. */
export function searchHistoryForSelection(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  setView('history');
  setHistoryQuery({ ...EMPTY_HISTORY_QUERY, content: trimmed });
  document.getElementById('history-search')?.focus();
}

// ---------------------------------------------------------------------------
// File history (History tab scoped to one file, following renames)
// ---------------------------------------------------------------------------

export function openFileHistory(path: string): void {
  patchHistory({ path, pathHistory: null, commits: [], hasMore: false, selectedShas: [], details: null, detailsLoading: false, selectedFile: null });
  setView('history');
  void loadHistory(true);
  void loadPathHistory(path);
}

export function clearFileHistory(): void {
  const h = store.get().history;
  if (!h.path) return;
  patchHistory({ path: null, pathHistory: null, commits: [], hasMore: false, selectedShas: [], details: null, detailsLoading: false, selectedFile: null });
  void loadHistory(true);
}

async function loadPathHistory(path: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    const entries = await invoke('repo.pathHistory', repo.path, path);
    if (store.get().history.path !== path) return;
    patchHistory({ pathHistory: entries });
    const h = store.get().history;
    if (h.selectedShas.length === 1) void loadCommitDetails(h.selectedShas[0]);
  } catch {
    // Best-effort: without a rename map, file-history selection falls back to the current path.
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** path|rev of the file the blame gutter was last computed for; used to auto-turn it off when the user switches files/commits. */
let lastBlameTarget: string | null = null;
const blameCache = new Map<string, BlameResult>();

export function clearBlameCache(): void {
  blameCache.clear();
}

export async function loadDiff(force = false): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo) {
    patchDiff({ key: null, diff: null, loading: false, error: null, selectedLines: null, blame: null, blameOn: false, highlightTerm: null, revealLine: null });
    return;
  }
  const opts = { hideWhitespace: s.settings?.diffHideWhitespace ?? false };
  let key: string | null = null;
  let fetcher: (() => Promise<FileDiff>) | null = null;
  let selectedLines: string[] | null = null;
  /** First-matching-line highlight for an active content/regex history search. */
  let highlightTerm: { text: string; regex: boolean } | null = null;
  /** Set only for views where blame is a supported entry point (Changes and History). */
  let blameTarget: { path: string; rev: string | null } | null = null;
  /** The Changes tab's selected working-tree path, if any; used to capture a conflicted file's pre-resolution content the first time it loads (see captureConflictOriginal). */
  let workingPath: string | null = null;
  if (s.review.open && s.review.run) {
    const run = s.review.run;
    const f = s.review.selectedPath;
    if (f) {
      key = `review:${run.id}:${f}`;
      const target = run.target;
      fetcher = target.kind === 'pr' ? () => invoke('gh.pr.fileDiff', repo.path, target.number, f, opts) : () => invoke('repo.diff.range', repo.path, target.baseSha, target.headSha, f, opts);
    }
  } else if (s.view === 'changes') {
    if (s.changes.selectedPaths.length === 1) {
      const path = s.changes.selectedPaths[0];
      key = `working:${path}`;
      fetcher = () => invoke('repo.diff.working', repo.path, path, opts);
      selectedLines = s.changes.excluded.includes(path) ? [] : s.changes.partial[path] ?? null;
      blameTarget = { path, rev: null };
      workingPath = path;
    }
  } else if (s.view === 'stashes') {
    const stash = s.stashes.find((st) => st.sha === s.stashesView.selectedSha);
    const f = s.stashesView.selectedFile;
    if (stash && f) {
      key = `stash:${stash.sha}:${f}`;
      // Pass the SHA (not the positional stash@{N} ref): it stays valid even if another
      // stash is pushed or dropped between selecting this row and fetching its diff.
      fetcher = () => invoke('repo.diff.stash', repo.path, stash.sha, f, opts);
    }
  } else if (s.history.selectedShas.length === 1 && s.history.selectedFile) {
    const sha = s.history.selectedShas[0];
    const f = s.history.selectedFile;
    key = `commit:${sha}:${f}`;
    fetcher = () => invoke('repo.commit.diff', repo.path, sha, f, opts);
    blameTarget = { path: f, rev: sha };
    if (s.history.query.content) highlightTerm = { text: s.history.query.content, regex: !!s.history.query.contentRegex };
    else if (s.history.query.diffRegex) highlightTerm = { text: s.history.query.diffRegex, regex: true };
  }

  const blameTargetKey = blameTarget ? `${blameTarget.path}|${blameTarget.rev ?? ''}` : null;
  if (blameTargetKey !== lastBlameTarget) {
    lastBlameTarget = blameTargetKey;
    if (store.get().diff.blameOn) patchDiff({ blameOn: false, blame: null, blameLoading: false });
  }

  if (store.get().diff.blameOn && blameTarget) {
    const { path, rev } = blameTarget;
    const ignoreWhitespace = s.settings?.blameIgnoreWhitespace ?? true;
    key = `blame:${path}:${rev ?? 'wt'}:${ignoreWhitespace}`;
    fetcher = async () => {
      const cacheKey = `${repo.path}|${key}`;
      let result = blameCache.get(cacheKey) ?? null;
      if (!result) {
        patchDiff({ blameLoading: true });
        try {
          result = await invoke('repo.blame', repo.path, path, rev, ignoreWhitespace);
          blameCache.set(cacheKey, result);
        } finally {
          patchDiff({ blameLoading: false });
        }
      }
      if (store.get().diff.key === key) patchDiff({ blame: result });
      if (result.tooLarge) return { kind: 'too-large', lineCount: result.lineCount, bytes: 0 };
      if (result.binary) return { kind: 'binary', oldBytes: null, newBytes: null };
      if (result.content === null) return { kind: 'empty', reason: 'Could not load file content for blame.' };
      return buildFileViewDiff(path, result.content);
    };
  } else if (store.get().diff.blame) {
    patchDiff({ blame: null });
  }

  if (!key || !fetcher) {
    patchDiff({ key: null, diff: null, loading: false, error: null, selectedLines: null, blame: null, highlightTerm: null, revealLine: null });
    return;
  }
  key += `|ws=${opts.hideWhitespace}`;
  if (!force && s.diff.key === key && (s.diff.diff || s.diff.loading) && s.diff.highlightTerm?.text === highlightTerm?.text) return;
  const samePath = s.diff.key !== null && s.diff.key.split('|')[0] === key.split('|')[0];
  patchDiff({ key, loading: !samePath || !s.diff.diff, error: null, selectedLines, diff: samePath ? s.diff.diff : null, highlightTerm, ...(samePath ? {} : { revealLine: null }) });
  try {
    const diff = await fetcher();
    if (store.get().diff.key !== key) return;
    patchDiff({ diff, loading: false, error: null });
    if (workingPath && diff.kind === 'conflict') captureConflictOriginal(workingPath, diff.content);
  } catch (err) {
    if (store.get().diff.key !== key) return;
    patchDiff({ diff: null, loading: false, error: errorMessage(err) });
  }
}

export function toggleBlame(): void {
  patchDiff({ blameOn: !store.get().diff.blameOn, activeBlameId: null });
  void loadDiff(true);
}

export function setActiveBlame(id: string | null): void {
  const current = store.get().diff.activeBlameId;
  patchDiff({ activeBlameId: current === id ? null : id });
}

/** Re-blames the file as of the commit before `hunk`'s commit, using the path it had back then. */
export function blameAtParent(hunk: BlameHunk): void {
  const s = store.get();
  if (!hunk.previousSha) return;
  // Pre-sync the "last blamed target" so the loadDiff() triggered by the navigation below doesn't
  // treat this as a plain file/commit switch and turn blame back off.
  lastBlameTarget = `${hunk.originalPath}|${hunk.previousSha}`;
  patchDiff({ activeBlameId: null, blameOn: true });
  if (s.view === 'history') {
    patchHistory({ selectedShas: [hunk.previousSha], selectedFile: hunk.originalPath, details: null });
    void loadCommitDetails(hunk.previousSha);
  } else {
    // Changes tab: blame stays on the working tree; there is no "commit" to move the whole view to,
    // so jump to History at the parent commit instead, which is where "blame at a commit" belongs.
    setView('history');
    selectCommit(hunk.previousSha);
    patchHistory({ selectedFile: hunk.originalPath });
  }
}

export function openCommitFromBlame(hunk: BlameHunk): void {
  if (hunk.sha === ZERO_SHA) return;
  setView('history');
  selectCommit(hunk.sha);
}

// ---------------------------------------------------------------------------
// File history actions: view a past version, restore it to the working tree.
// ---------------------------------------------------------------------------

export function openFileAtCommit(path: string, sha: string): void {
  openDialog({ kind: 'file-at-commit', path, sha });
}

export function requestRestoreFile(path: string, sha: string): void {
  const repo = store.get().currentRepo;
  if (!repo) return;
  const dirty = !!store.get().status?.files.some((f) => f.path === path);
  let stashFirst = false;
  openDialog({
    kind: 'confirm',
    title: 'Restore this version?',
    message: `The working copy of "${path}" will be overwritten with its content from ${sha.slice(0, 7)}.${dirty ? ' You have uncommitted changes to this file.' : ''}`,
    confirmLabel: 'Restore',
    checkbox: dirty ? { label: 'Stash my current changes to this file first', onChange: (v) => { stashFirst = v; } } : undefined,
    onConfirm: () => restoreFileVersion(path, sha, dirty && stashFirst),
  });
}

export async function restoreFileVersion(path: string, sha: string, stashFirst: boolean): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo) return;
  try {
    if (stashFirst) await invoke('git.stash.push', repo.path, `Stashed before restoring ${path}`, true, [path]);
    const result = await invoke('repo.fileAtCommit', repo.path, sha, path);
    if (result.content === null) {
      showToast({ kind: 'error', title: 'Could not restore file', message: result.binary ? 'The file is binary.' : 'The file is too large to restore this way.' });
      return;
    }
    await invoke('repo.writeFile', repo.path, path, result.content);
    showToast({ kind: 'success', title: `Restored ${path.split('/').pop()}`, message: `Reverted to its content at ${sha.slice(0, 7)}.` });
    await refreshStatus();
    if (stashFirst) await refreshStashes();
    if (store.get().view === 'changes') void loadDiff(true);
  } catch (err) {
    showError('Could not restore file', err);
  }
}
