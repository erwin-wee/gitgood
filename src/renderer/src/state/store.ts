import { useSyncExternalStore } from 'react';
import type { AiResolveProgressEvent, AiReviewProgressEvent, AppSettings, BlameResult, Branch, Commit, CommitDetails, CommitFile, ConflictResolutionResult, ErrorExplanation, ExplainFollowUp, ExplainTarget, Explanation, FileDiff, GitErrorInfo, HistoryQuery, InboxState, LfsStatus, NlPlan, NlStep, PathHistoryEntry, PostResolveCheckResult, PrTriage, ProgressEvent, PullRequest, RebaseApplyProgress, RebasePlan, RebasePreflight, Remote, RepositoryInfo, RepositoryStatus, RepoWork, ReviewPlan, ReviewRun, ReviewRunTarget, ReviewTarget, SplitApplyProgress, SplitPlan, SplitPreflight, Stash, StaleBranch, Submodule, Tag, ToolsState, UpdateState, WorktreeReviewTarget, Worktree } from '@shared/types';
import { EMPTY_HISTORY_QUERY } from '@shared/types';

/** A `ReviewRun` known to target a pull request or a branch (never the pre-commit `worktree` target), which is all `ai.review.start`/`ai.review.get` for a `ReviewTarget` ever produce. */
export type PrReviewRun = ReviewRun & { target: Exclude<ReviewRunTarget, WorktreeReviewTarget> };

/** A `ReviewRun` known to target the pending commit's patch. */
export type WorktreeReviewRun = ReviewRun & { target: WorktreeReviewTarget };

export type View = 'changes' | 'history' | 'stashes' | 'health';
export type Popover = 'repos' | 'branches' | 'history-filter' | null;
export type SettingsTab = 'accounts' | 'integrations' | 'git' | 'appearance' | 'prompts' | 'ai' | 'advanced';
export type RepoSettingsTab = 'remote' | 'ignored' | 'identity' | 'alias';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
  sticky?: boolean;
}

export type DialogState =
  | { kind: 'clone'; url?: string }
  | { kind: 'new-repo' }
  | { kind: 'add-repo' }
  | { kind: 'new-branch'; startPoint?: string | null; startPointLabel?: string; initialName?: string }
  | { kind: 'rename-branch'; branch: string }
  | { kind: 'delete-branch'; branch: Branch }
  | { kind: 'merge'; squash: boolean; preselect?: string }
  | { kind: 'rebase'; preselect?: string }
  | { kind: 'compare' }
  | { kind: 'discard'; paths: string[]; all: boolean }
  | { kind: 'discard-lines'; path: string; patch: string; count: number }
  | { kind: 'create-pr'; autoDraft?: boolean }
  | { kind: 'pr-details'; pr: PullRequest }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'about' }
  | { kind: 'repo-settings'; tab?: RepoSettingsTab }
  | { kind: 'squash'; shas: string[]; targetSha: string }
  | { kind: 'reword'; commit: Commit }
  | { kind: 'tag'; sha: string }
  | { kind: 'publish' }
  | { kind: 'force-push' }
  | { kind: 'sign-in' }
  | { kind: 'error'; title: string; error: GitErrorInfo | string; retry?: () => void }
  | { kind: 'conflicts' }
  | { kind: 'uncommitted-changes'; targetLabel: string; proceed: (strategy: 'stash' | 'move') => Promise<void> }
  | { kind: 'shortcuts' }
  | { kind: 'remove-repo'; repo: RepositoryInfo }
  | { kind: 'cherry-pick'; shas: string[] }
  | { kind: 'stash-conflict'; stash: Stash }
  | { kind: 'branch-from-stash'; stash: Stash }
  | { kind: 'stash-selected-files'; paths: string[] }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; checkbox?: { label: string; onChange: (v: boolean) => void } }
  | { kind: 'edit-commit-message'; sha: string }
  | { kind: 'review-preflight'; target: ReviewTarget }
  | { kind: 'review-post' }
  | { kind: 'precommit-review-gate'; run: WorktreeReviewRun; onCommitAnyway: () => void }
  | { kind: 'worktrees' }
  | { kind: 'add-worktree'; startBranch?: string | null }
  | { kind: 'remove-worktree'; worktree: Worktree }
  | { kind: 'lock-worktree'; worktree: Worktree }
  | { kind: 'prune-worktrees'; worktrees: Worktree[] }
  | { kind: 'file-at-commit'; path: string; sha: string }
  | { kind: 'submodules' }
  | { kind: 'lfs' }
  | { kind: 'bulk-delete-branches'; branches: StaleBranch[] }
  | { kind: 'signing-failed'; error: GitErrorInfo; onRetry: () => void; onUnsigned: () => void }
  | { kind: 'issues'; number?: number }
  | { kind: 'new-issue'; owner?: string | null }
  | { kind: 'export-settings' }
  | { kind: 'import-settings' }
  | { kind: 'update-notes'; version: string; notes: string; url: string }
  | { kind: 'release-notes'; fromTag: string | null }
  | { kind: 'split-plan' }
  | { kind: 'tidy-branch' }
  | { kind: 'trust-repo-check'; repoPath: string; command: string; onDecision: (trusted: boolean) => void }
  | { kind: 'resolution-popover'; path: string; blockId: number }
  | { kind: 'command-palette' };

export interface ChangesState {
  selectedPaths: string[];
  excluded: string[];
  partial: Record<string, string[]>;
  summary: string;
  description: string;
  coAuthors: { name: string; email: string }[];
  showCoAuthors: boolean;
  amend: boolean;
  committing: boolean;
}

export interface StashesViewState {
  /** True while the stash list itself is (re)loading. */
  loading: boolean;
  selectedSha: string | null;
  files: CommitFile[];
  filesLoading: boolean;
  selectedFile: string | null;
}

export interface HistoryState {
  commits: Commit[];
  hasMore: boolean;
  loading: boolean;
  /** Raw text box value (may include `key:value` filter prefixes; see shared/util parseHistoryQuery). */
  search: string;
  /** Structured filters parsed out of `search`; kept in sync with the filter popover. */
  query: HistoryQuery;
  /** Free text left over after removing recognized `key:value` prefixes from `search` (used for the message/author/SHA match). */
  freeText: string;
  /** Inline validation error for an invalid `regex:` expression, shown instead of running a search. */
  queryError: string | null;
  /** True once the current search has been loading for more than 5s (suggests narrowing with `path:`). */
  slowSearch: boolean;
  selectedShas: string[];
  details: CommitDetails | null;
  detailsLoading: boolean;
  selectedFile: string | null;
  /** Files (paths) whose diff matches the active content/regex query for the selected commit; null when no such filter is active. */
  matchingFiles: string[] | null;
  dragging: string[] | null;
  /** Non-null when the History tab is scoped to one file's history (following renames). */
  path: string | null;
  /** sha -> the tracked file's path at that commit, for `path` (from `repo.pathHistory`); null while loading or inactive. */
  pathHistory: PathHistoryEntry[] | null;
}

export interface ReviewState {
  /** The run shown in the review view, if any. */
  run: PrReviewRun | null;
  /** True while the review view replaces the main content area. */
  open: boolean;
  running: boolean;
  progress: AiReviewProgressEvent | null;
  plan: ReviewPlan | null;
  planLoading: boolean;
  planError: string | null;
  selectedPath: string | null;
  activeFindingId: string | null;
  /** Head SHA of the target as last observed, to detect stale runs. */
  currentHeadSha: string | null;
  panelCollapsed: boolean;
}

export const initialReview: ReviewState = { run: null, open: false, running: false, progress: null, plan: null, planLoading: false, planError: null, selectedPath: null, activeFindingId: null, currentHeadSha: null, panelCollapsed: false };

/** AI pull request triage cache for the current repository (add-ai-pr-triage), mirrored from the main process's per-repository JSON cache. */
export interface TriageUiState {
  byNumber: Record<number, PrTriage>;
  loading: boolean;
  progress: { done: number; total: number } | null;
  loadedAt: number;
}

export const initialTriage: TriageUiState = { byNumber: {}, loading: false, progress: null, loadedAt: 0 };

/** Pre-commit review state (add-ai-precommit-review): reviews the exact patch the pending commit would apply, shown inline in the Changes tab rather than in a separate view. */
export interface PrecommitReviewState {
  run: WorktreeReviewRun | null;
  running: boolean;
  progress: AiReviewProgressEvent | null;
  /** Paths in `run` whose file content changed since the review ran (see ai.review.worktreeStale). */
  stalePaths: string[];
  /** True while the findings strip above the commit form is expanded. */
  expanded: boolean;
  activeFindingId: string | null;
}

export const initialPrecommitReview: PrecommitReviewState = { run: null, running: false, progress: null, stalePaths: [], expanded: false, activeFindingId: null };

/** AI commit splitting (add-ai-commit-splitting): pre-flight summary, the editable proposed plan, and apply/undo progress. `plan` doubles as the live, user-edited working copy (dragging a hunk, merging or deleting a commit mutates it in place via patchSplit). */
export interface SplitUiState {
  preflight: SplitPreflight | null;
  preflightLoading: boolean;
  preflightError: string | null;
  /** True once the pre-flight offered a file-only proposal (over the byte budget) and the user chose it; passed straight through to `ai.split.plan`, which always sends headers/stats only above the budget regardless, but this reflects the user's explicit choice for the UI. */
  fileOnly: boolean;
  plan: SplitPlan | null;
  planLoading: boolean;
  planError: string | null;
  selectedHunkId: string | null;
  applying: boolean;
  applyProgress: SplitApplyProgress | null;
  /** Set after Apply fails so the dialog can offer Re-propose; `stale` marks a working-tree-changed refusal specifically. */
  applyError: { message: string; stale: boolean } | null;
  /** Set right after a successful apply, so the completion toast's Undo action and the "still safe to undo" check have what they need; cleared once undone or once the user commits/splits again. */
  lastApplied: { startSha: string; headSha: string; commitCount: number } | null;
}

export const initialSplit: SplitUiState = {
  preflight: null,
  preflightLoading: false,
  preflightError: null,
  fileOnly: false,
  plan: null,
  planLoading: false,
  planError: null,
  selectedHunkId: null,
  applying: false,
  applyProgress: null,
  applyError: null,
  lastApplied: null,
};

/** AI rebase assistant (add-ai-rebase-assistant): pre-flight summary (editable base, counts, pushed/signing warnings) and the editable proposed todo list. `plan` doubles as the live, user-edited working copy, mirroring SplitUiState. */
export interface RebaseUiState {
  /** A History multi-selection scope, or null for "the whole branch ahead of base". */
  shas: string[] | null;
  /** The base ref as typed/defaulted in the pre-flight; editable before Propose. */
  base: string;
  preflight: RebasePreflight | null;
  preflightLoading: boolean;
  preflightError: string | null;
  /** From repo.signing.get: true when commit signing is configured (rewriting drops signatures). */
  signingWarning: boolean;
  plan: RebasePlan | null;
  planLoading: boolean;
  planError: string | null;
  applying: boolean;
  applyProgress: RebaseApplyProgress | null;
  applyError: string | null;
  /** Set after a successful apply, so the completion toast's Undo action has what it needs; cleared once undone. */
  lastApplied: { startSha: string } | null;
}

export const initialRebase: RebaseUiState = {
  shas: null,
  base: '',
  preflight: null,
  preflightLoading: false,
  preflightError: null,
  signingWarning: false,
  plan: null,
  planLoading: false,
  planError: null,
  applying: false,
  applyProgress: null,
  applyError: null,
  lastApplied: null,
};

/**
 * AI command palette (add-ai-command-palette). `plan` is the currently shown
 * plan (from a built-in match there is none: built-ins run directly without
 * ever touching this state). `history` keeps the session's last 20 plans and
 * their outcomes in memory only, per spec.md ("discard them when the app
 * exits") — nothing here is written to disk.
 */
export interface NlPaletteHistoryEntry {
  id: string;
  request: string;
  steps: NlStep[];
  ranAt: number;
  /** Step ids that finished running, in order. */
  completed: string[];
  /** Step id the run stopped on, or null when every confirmed step completed (or none were ever confirmed, e.g. the plan was only copied). */
  failedStep: string | null;
  cancelled: boolean;
}

export interface NlPaletteUiState {
  query: string;
  loading: boolean;
  error: string | null;
  plan: NlPlan | null;
  /** Set once a clarifying question is shown and the answer box should be offered; cleared once a further plan request is sent. */
  answerDraft: string;
  /** Step ids currently running/finished for the plan in view, for the plan card's per-step spinners/badges. */
  stepPhase: Record<string, 'running' | 'done' | 'error'>;
  completed: string[];
  failedStep: string | null;
  history: NlPaletteHistoryEntry[];
}

export const initialNlPalette: NlPaletteUiState = { query: '', loading: false, error: null, plan: null, answerDraft: '', stepPhase: {}, completed: [], failedStep: null, history: [] };

const EXPLAIN_WIDTH_KEY = 'gitgood.explainPanelWidth';
const EXPLAIN_WIDTH_MIN = 260;
const EXPLAIN_WIDTH_MAX = 640;
const EXPLAIN_WIDTH_DEFAULT = 340;

function loadExplainPanelWidth(): number {
  try {
    const raw = localStorage.getItem(EXPLAIN_WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= EXPLAIN_WIDTH_MIN && n <= EXPLAIN_WIDTH_MAX ? n : EXPLAIN_WIDTH_DEFAULT;
  } catch {
    return EXPLAIN_WIDTH_DEFAULT;
  }
}

export function saveExplainPanelWidth(width: number): number {
  const clamped = Math.max(EXPLAIN_WIDTH_MIN, Math.min(EXPLAIN_WIDTH_MAX, Math.round(width)));
  try {
    localStorage.setItem(EXPLAIN_WIDTH_KEY, String(clamped));
  } catch {
    /* private mode / storage disabled: keep the in-memory width for this session only */
  }
  return clamped;
}

/** Explanation shown for the currently explained target (a commit, a file's diff, or a selected line range); see components/explain/ExplainPanel.tsx. */
export interface ExplainState {
  /** True while the panel replaces/sits beside the diff. */
  open: boolean;
  target: ExplainTarget | null;
  /** Short label for the panel header, e.g. "Commit 1a2b3c4" or "src/app.ts:12-18". */
  label: string | null;
  loading: boolean;
  error: string | null;
  result: Explanation | null;
  followUps: ExplainFollowUp[];
  followUpDraft: string;
  followUpLoading: boolean;
  followUpError: string | null;
  panelCollapsed: boolean;
  width: number;
}

export const initialExplain: ExplainState = {
  open: false,
  target: null,
  label: null,
  loading: false,
  error: null,
  result: null,
  followUps: [],
  followUpDraft: '',
  followUpLoading: false,
  followUpError: null,
  panelCollapsed: false,
  width: loadExplainPanelWidth(),
};

export interface InboxUiState {
  /** True while the notifications slide-over panel is shown. */
  open: boolean;
  filter: 'all' | 'review' | 'failures' | 'mentions';
  /** Only show notifications for repositories already added to GitGood. */
  onlyKnownRepos: boolean;
  /** Highlighted and scrolled into view, e.g. after a desktop-notification click. */
  focusItemId: string | null;
}

/** State for the error dialog's "Explain with AI" section. Keyed loosely to the dialog's error code (`forCode`) so a stale result never shows after Retry re-runs the operation and lands on a different error. */
export interface ErrorExplainState {
  forCode: GitErrorInfo['code'] | null;
  loading: boolean;
  error: string | null;
  result: ErrorExplanation | null;
  /** True once the user has voted helpful/not-helpful on the current result. */
  feedbackGiven: boolean;
}

export const initialErrorExplain: ErrorExplainState = { forCode: null, loading: false, error: null, result: null, feedbackGiven: false };

export const initialInboxUi: InboxUiState = { open: false, filter: 'all', onlyKnownRepos: false, focusItemId: null };
export const initialInbox: InboxState = { items: [], unreadCount: 0, lastPolledAt: null, paused: null, pausedUntil: null };

export interface DiffState {
  key: string | null;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** Selected line keys "hunk:line" for the working diff (partial commit). */
  selectedLines: string[] | null;
  /** Whether the blame gutter is toggled on for the currently shown file. */
  blameOn: boolean;
  blame: BlameResult | null;
  blameLoading: boolean;
  /** Block whose hover card is open, keyed "sha:startLine" (unique even when the same commit has several runs). */
  activeBlameId: string | null;
  /** Set when a content/regex history search is active, so the diff pane can scroll to and highlight the first matching line. */
  highlightTerm: { text: string; regex: boolean } | null;
}

/** Post-resolution check failure banner (add-ai-conflict-resolution-upgrade). One at a time, per repository; replaced on the next resolution's check result. */
export interface CheckBannerState {
  path: string;
  result: PostResolveCheckResult;
  /** True once "Ask AI to fix" has been used for this file; a second failure keeps this true so the banner drops the retry action (at most one retry per resolution). */
  retried: boolean;
  /** The true pre-resolution conflicted content (with markers), carried over so a retry can be requested even though the file on disk no longer has markers. */
  original: string;
}

/** Stable empty selector result: useSyncExternalStore re-renders forever if a selector returns a fresh array/object each call. */
export const NO_CONFLICT_EXAMPLES: string[] = [];

export interface AppState {
  settings: AppSettings | null;
  tools: ToolsState | null;
  dark: boolean;
  repos: RepositoryInfo[];
  currentRepo: RepositoryInfo | null;
  status: RepositoryStatus | null;
  statusLoading: boolean;
  branches: Branch[];
  defaultBranch: string | null;
  stashes: Stash[];
  tags: Tag[];
  remotes: Remote[];
  view: View;
  changes: ChangesState;
  history: HistoryState;
  stashesView: StashesViewState;
  diff: DiffState;
  prs: { list: PullRequest[]; loading: boolean; current: PullRequest | null; loadedAt: number; error: string | null };
  triage: TriageUiState;
  dialog: DialogState | null;
  dialogStack: DialogState[];
  popover: Popover;
  toasts: Toast[];
  progress: Record<string, ProgressEvent>;
  operation: string | null;
  ai: Record<string, AiResolveProgressEvent>;
  /** Last resolution result per conflicted-file path (AI or per-block side selection), used to render confidence tints/gutter badges and the conflicts dialog's per-file summary. Cleared per-path on external edit and entirely once the operation ends. */
  conflictResolutions: Record<string, ConflictResolutionResult>;
  /** File content immediately after the resolution recorded in `conflictResolutions`, used to detect an external edit (see pruneStaleConflictTints). */
  conflictSnapshots: Record<string, string>;
  /** Every block's current range for a path (unlike `conflictResolutions[path].blocks`, this always includes a block once it has been manually overridden via useSideForBlock, so a further pick can still locate it from the immutable original snapshot). */
  conflictBlockRanges: Record<string, { id: number; start: number; end: number }[]>;
  /** The pre-resolution conflicted content (with markers) for a path, captured the first time it is seen as conflicted; used to record "Resolve remaining like …" worked examples when the user later marks it resolved. */
  conflictOriginals: Record<string, string>;
  /** Paths with a manual resolution recorded for the current operation (see `ai.resolve.examples`); offered as "Resolve remaining like …" in the conflicts dialog. */
  conflictExamples: string[];
  /** The post-resolution check failure banner, or null when no check has failed (or none is configured). */
  checkBanner: CheckBannerState | null;
  review: ReviewState;
  precommitReview: PrecommitReviewState;
  split: SplitUiState;
  rebase: RebaseUiState;
  explain: ExplainState;
  errorExplain: ErrorExplainState;
  nlPalette: NlPaletteUiState;
  /** Local-only, never sent anywhere: cumulative "was this helpful?" votes on AI error explanations across the session. */
  aiErrorFeedback: { helpful: number; notHelpful: number };
  aiBusy: boolean;
  aiCommitBusy: boolean;
  login: { inProgress: boolean; code: string | null; url: string | null; error: string | null };
  sidebarWidth: number;
  focused: boolean;
  lastSuccessfulMerge: { branch: string; at: number } | null;
  avatars: Record<string, string | null>;
  /** Refreshed alongside status; drive the post-clone submodule banner, the LFS install banner and both dialogs. */
  submodules: Submodule[];
  lfsStatus: LfsStatus | null;
  /** Dismissed for the current repository's current HEAD; re-shown after further submodule changes. */
  submoduleBannerDismissed: boolean;
  /** Unpushed work across every repository on disk; loaded on demand for the Welcome screen and, opt-in, the repository list's warning dot. */
  work: RepoWork[];
  /** Bumped whenever signing config is saved from Options → Git, so the commit form's signing indicator re-fetches without needing a repo switch. */
  signingConfigVersion: number;
  /** Bumped after a settings-sync action (enable/upload/download/disconnect) completes, so the sync card re-fetches status even though its confirmation dialog remounted it mid-action. */
  settingsSyncVersion: number;
  /** GitHub notifications inbox, mirrored from the main-process poller (see gh.inbox.changed). */
  inbox: InboxState;
  inboxUi: InboxUiState;
  /** Auto-update state, mirrored from the main-process updater (see app.update.changed). */
  updateState: UpdateState;
}

export const initialChanges: ChangesState = {
  selectedPaths: [],
  excluded: [],
  partial: {},
  summary: '',
  description: '',
  coAuthors: [],
  showCoAuthors: false,
  amend: false,
  committing: false,
};

export const initialStashesView: StashesViewState = { loading: false, selectedSha: null, files: [], filesLoading: false, selectedFile: null };

export const initialHistory: HistoryState = { commits: [], hasMore: false, loading: false, search: '', query: EMPTY_HISTORY_QUERY, freeText: '', queryError: null, slowSearch: false, selectedShas: [], details: null, detailsLoading: false, selectedFile: null, matchingFiles: null, dragging: null, path: null, pathHistory: null };

export const initialDiff: DiffState = { key: null, diff: null, loading: false, error: null, selectedLines: null, blameOn: false, blame: null, blameLoading: false, activeBlameId: null, highlightTerm: null };

const initialState: AppState = {
  settings: null,
  tools: null,
  dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  repos: [],
  currentRepo: null,
  status: null,
  statusLoading: false,
  branches: [],
  defaultBranch: null,
  stashes: [],
  tags: [],
  remotes: [],
  view: 'changes',
  changes: initialChanges,
  history: initialHistory,
  stashesView: initialStashesView,
  diff: initialDiff,
  prs: { list: [], loading: false, current: null, loadedAt: 0, error: null },
  triage: initialTriage,
  dialog: null,
  dialogStack: [],
  popover: null,
  toasts: [],
  progress: {},
  operation: null,
  ai: {},
  conflictResolutions: {},
  conflictSnapshots: {},
  conflictBlockRanges: {},
  conflictOriginals: {},
  conflictExamples: NO_CONFLICT_EXAMPLES,
  checkBanner: null,
  review: initialReview,
  precommitReview: initialPrecommitReview,
  split: initialSplit,
  rebase: initialRebase,
  explain: initialExplain,
  errorExplain: initialErrorExplain,
  nlPalette: initialNlPalette,
  aiErrorFeedback: { helpful: 0, notHelpful: 0 },
  aiBusy: false,
  aiCommitBusy: false,
  login: { inProgress: false, code: null, url: null, error: null },
  sidebarWidth: 300,
  focused: true,
  lastSuccessfulMerge: null,
  avatars: {},
  submodules: [],
  lfsStatus: null,
  submoduleBannerDismissed: false,
  work: [],
  signingConfigVersion: 0,
  settingsSyncVersion: 0,
  inbox: initialInbox,
  inboxUi: initialInboxUi,
  updateState: { status: 'idle' },
};

type Listener = () => void;

class Store {
  private state: AppState = initialState;
  private listeners = new Set<Listener>();

  get = (): AppState => this.state;

  set = (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof AppState)[]) {
      if (!Object.is(this.state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const store = new Store();

export function useAppStore<R>(selector: (s: AppState) => R): R {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

export function patchChanges(patch: Partial<ChangesState> | ((c: ChangesState) => Partial<ChangesState>)): void {
  store.set((s) => ({ changes: { ...s.changes, ...(typeof patch === 'function' ? patch(s.changes) : patch) } }));
}

export function patchHistory(patch: Partial<HistoryState> | ((h: HistoryState) => Partial<HistoryState>)): void {
  store.set((s) => ({ history: { ...s.history, ...(typeof patch === 'function' ? patch(s.history) : patch) } }));
}

export function patchStashesView(patch: Partial<StashesViewState> | ((v: StashesViewState) => Partial<StashesViewState>)): void {
  store.set((s) => ({ stashesView: { ...s.stashesView, ...(typeof patch === 'function' ? patch(s.stashesView) : patch) } }));
}

export function patchReview(patch: Partial<ReviewState> | ((r: ReviewState) => Partial<ReviewState>)): void {
  store.set((s) => ({ review: { ...s.review, ...(typeof patch === 'function' ? patch(s.review) : patch) } }));
}

export function patchPrecommitReview(patch: Partial<PrecommitReviewState> | ((r: PrecommitReviewState) => Partial<PrecommitReviewState>)): void {
  store.set((s) => ({ precommitReview: { ...s.precommitReview, ...(typeof patch === 'function' ? patch(s.precommitReview) : patch) } }));
}

export function patchSplit(patch: Partial<SplitUiState> | ((s: SplitUiState) => Partial<SplitUiState>)): void {
  store.set((s) => ({ split: { ...s.split, ...(typeof patch === 'function' ? patch(s.split) : patch) } }));
}

export function patchRebase(patch: Partial<RebaseUiState> | ((s: RebaseUiState) => Partial<RebaseUiState>)): void {
  store.set((s) => ({ rebase: { ...s.rebase, ...(typeof patch === 'function' ? patch(s.rebase) : patch) } }));
}

export function patchTriage(patch: Partial<TriageUiState> | ((t: TriageUiState) => Partial<TriageUiState>)): void {
  store.set((s) => ({ triage: { ...s.triage, ...(typeof patch === 'function' ? patch(s.triage) : patch) } }));
}

export function patchDiff(patch: Partial<DiffState>): void {
  store.set((s) => ({ diff: { ...s.diff, ...patch } }));
}

export function patchExplain(patch: Partial<ExplainState> | ((e: ExplainState) => Partial<ExplainState>)): void {
  store.set((s) => ({ explain: { ...s.explain, ...(typeof patch === 'function' ? patch(s.explain) : patch) } }));
}

export function patchInboxUi(patch: Partial<InboxUiState> | ((u: InboxUiState) => Partial<InboxUiState>)): void {
  store.set((s) => ({ inboxUi: { ...s.inboxUi, ...(typeof patch === 'function' ? patch(s.inboxUi) : patch) } }));
}

export function patchErrorExplain(patch: Partial<ErrorExplainState> | ((e: ErrorExplainState) => Partial<ErrorExplainState>)): void {
  store.set((s) => ({ errorExplain: { ...s.errorExplain, ...(typeof patch === 'function' ? patch(s.errorExplain) : patch) } }));
}

export function patchNlPalette(patch: Partial<NlPaletteUiState> | ((p: NlPaletteUiState) => Partial<NlPaletteUiState>)): void {
  store.set((s) => ({ nlPalette: { ...s.nlPalette, ...(typeof patch === 'function' ? patch(s.nlPalette) : patch) } }));
}

let toastId = 0;
export function showToast(toast: Omit<Toast, 'id'>, timeoutMs = 6000): number {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
  if (!toast.sticky) setTimeout(() => dismissToast(id), timeoutMs);
  return id;
}

export function dismissToast(id: number): void {
  store.set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : {}));
}

export function openDialog(dialog: DialogState): void {
  store.set((s) => ({ dialog, dialogStack: s.dialog ? [...s.dialogStack, s.dialog] : s.dialogStack, popover: null }));
}

export function closeDialog(): void {
  store.set((s) => {
    const stack = [...s.dialogStack];
    const previous = stack.pop() ?? null;
    return { dialog: previous, dialogStack: stack };
  });
}

export function closeAllDialogs(): void {
  store.set({ dialog: null, dialogStack: [] });
}

export function setPopover(popover: Popover): void {
  store.set((s) => ({ popover: s.popover === popover ? null : popover }));
}
