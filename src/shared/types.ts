/**
 * Shared data types that cross the IPC boundary between the Electron main
 * process and the renderer. Keep this file free of Node or DOM specifics.
 */

export type Theme = 'system' | 'light' | 'dark';
export type DiffViewMode = 'unified' | 'split';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PullBehavior = 'git-config' | 'merge' | 'rebase';
export type UncommittedChangesStrategy = 'ask' | 'stash' | 'move';

export interface AiSettings {
  /** Which backend performs AI conflict resolution. */
  provider: 'anthropic' | 'claude-cli' | 'disabled';
  /** Anthropic model ID used by the API backend, or a model alias for the CLI backend. */
  model: string;
  effort: EffortLevel;
  /** True when an API key has been stored (the key itself never crosses IPC). */
  hasApiKey: boolean;
  claudeCliPath: string | null;
  /** Mark files as resolved (git add) automatically after a successful AI resolution. */
  autoStageAfterResolve: boolean;
}

export interface AppSettings {
  theme: Theme;
  externalEditor: string | null;
  customEditorPath: string | null;
  shell: string | null;
  customShellPath: string | null;
  defaultCloneDirectory: string;
  confirmDiscardChanges: boolean;
  confirmDiscardChangesPermanently: boolean;
  confirmDiscardStash: boolean;
  confirmForcePush: boolean;
  confirmRepositoryRemoval: boolean;
  confirmUndoCommit: boolean;
  confirmCheckoutCommit: boolean;
  pullBehavior: PullBehavior;
  uncommittedChangesStrategy: UncommittedChangesStrategy;
  autoFetchIntervalMinutes: number;
  diffViewMode: DiffViewMode;
  diffHideWhitespace: boolean;
  diffShowIntraline: boolean;
  diffWrapLines: boolean;
  diffFontSize: number;
  diffSyntaxHighlighting: boolean;
  showCommitLengthWarning: boolean;
  repositoryIndicators: boolean;
  notifyPullRequestReviews: boolean;
  notifyPullRequestChecks: boolean;
  gitPath: string | null;
  ghPath: string | null;
  ai: AiSettings;
}

export interface GitHubRepoRef {
  host: string;
  owner: string;
  name: string;
  /** https://github.com/owner/name */
  url: string;
}

export interface RepositoryInfo {
  id: string;
  path: string;
  name: string;
  alias: string | null;
  missing: boolean;
  github: GitHubRepoRef | null;
  lastOpened: number;
  /** Cached ahead/behind indicator, refreshed in the background. */
  indicator?: { ahead: number; behind: number; hasChanges: boolean } | null;
}

export type FileStatusKind =
  | 'new'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'conflicted'
  | 'untracked'
  | 'typechange'
  | 'ignored';

export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'deleted-by-us'
  | 'deleted-by-them'
  | 'added-by-us'
  | 'added-by-them';

export interface WorkingFile {
  /** Repository-relative path using forward slashes. */
  path: string;
  oldPath: string | null;
  status: FileStatusKind;
  staged: boolean;
  unstaged: boolean;
  submodule: boolean;
  conflict: ConflictKind | null;
}

export type OperationKind = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface InProgressOperation {
  kind: OperationKind;
  /** Branch being rebased (rebase) or the current branch. */
  headName: string | null;
  /** Target of the rebase (sha or ref). */
  onto: string | null;
  ontoName: string | null;
  current: number | null;
  total: number | null;
  /** MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD sha */
  targetSha: string | null;
  targetName: string | null;
  message: string | null;
}

export interface BranchState {
  name: string | null;
  sha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
  /** True when the upstream ref no longer exists (e.g. deleted on remote). */
  upstreamGone: boolean;
}

export interface RepositoryStatus {
  branch: BranchState;
  files: WorkingFile[];
  operation: InProgressOperation;
  hasConflicts: boolean;
  /** Epoch ms of last fetch, derived from .git/FETCH_HEAD */
  lastFetched: number | null;
}

export interface Branch {
  /** Short name; for remote branches includes the remote prefix, e.g. origin/main. */
  name: string;
  kind: 'local' | 'remote';
  remote: string | null;
  sha: string;
  upstream: string | null;
  isCurrent: boolean;
  lastCommitDate: string;
  lastCommitSubject: string;
  lastCommitAuthor: string;
  ahead: number | null;
  behind: number | null;
  isDefault: boolean;
  /** True when the local branch has no upstream. */
  unpublished: boolean;
}

export interface Tag {
  name: string;
  sha: string;
  targetSha: string;
  annotated: boolean;
  message: string | null;
  date: string | null;
  /** Set when the tag is not present on the origin remote (best-effort). */
  unpushed: boolean;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Stash {
  index: number;
  ref: string;
  sha: string;
  message: string;
  branch: string | null;
  date: string;
  /** True when created by GitGood for the given branch (mirrors GitHub Desktop's convention). */
  createdByApp: boolean;
}

export interface Identity {
  name: string;
  email: string;
  date: string;
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  summary: string;
  body: string;
  refs: string[];
  coAuthors: { name: string; email: string }[];
  isMerge: boolean;
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  status: FileStatusKind;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetails {
  commit: Commit;
  files: CommitFile[];
  /** Whether this commit is reachable from any remote branch (used for the amend/undo UI). */
  pushed: boolean | null;
}

export interface HistoryPage {
  commits: Commit[];
  hasMore: boolean;
}

export type DiffLineType = 'context' | 'add' | 'delete' | 'hunk';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  noNewline: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ImagePayload {
  mediaType: string;
  base64: string;
  bytes: number;
}

export interface ConflictBlock {
  id: number;
  /** 0-based line indices into the file's line array (inclusive start, exclusive end). */
  start: number;
  end: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  base: string[] | null;
  theirs: string[];
}

export type FileDiff =
  | {
      kind: 'text';
      hunks: DiffHunk[];
      oldPath: string | null;
      newPath: string | null;
      language: string | null;
      lineCount: number;
      /** Full content of the new side (for context expansion / highlighting), when small enough. */
      newContent: string | null;
      oldContent: string | null;
      hasCRLF: boolean;
    }
  | { kind: 'binary'; oldBytes: number | null; newBytes: number | null }
  | { kind: 'image'; oldImage: ImagePayload | null; newImage: ImagePayload | null }
  | { kind: 'submodule'; oldSha: string | null; newSha: string | null; summary: string }
  | { kind: 'too-large'; lineCount: number; bytes: number }
  | { kind: 'conflict'; content: string; lines: string[]; blocks: ConflictBlock[]; language: string | null; oursLabel: string; theirsLabel: string }
  | { kind: 'empty'; reason: string };

export interface PullRequestChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  state: 'success' | 'failure' | 'pending' | 'none';
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headRepo: string | null;
  isCrossRepository: boolean;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  updatedAt: string;
  checks: PullRequestChecksSummary;
  reviewDecision: string | null;
  body: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  labels: string[];
  assignees: string[];
  reviewRequests: string[];
}

export interface CheckRun {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  link: string;
  workflow: string;
  description: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHubAccount {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  host: string;
  scopes: string[];
  protocol: string | null;
}

export interface ToolInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

export interface ToolsState {
  git: ToolInfo;
  gh: ToolInfo;
  claudeCli: ToolInfo;
  ghAccount: GitHubAccount | null;
  ghAuthError: string | null;
  credentialHelperConfigured: boolean;
}

export interface GitHubRepoSummary {
  nameWithOwner: string;
  name: string;
  owner: string;
  ownerAvatar: string | null;
  url: string;
  cloneUrl: string;
  isPrivate: boolean;
  isFork: boolean;
  description: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
}

export interface GitHubRepoDetails {
  nameWithOwner: string;
  url: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  isFork: boolean;
  parent: string | null;
  description: string | null;
  viewerCanAdminister: boolean;
  hasIssuesEnabled: boolean;
}

export interface ProgressEvent {
  id: string;
  kind: 'clone' | 'fetch' | 'pull' | 'push' | 'checkout' | 'ai' | 'generic';
  title: string;
  description: string;
  percent: number | null;
  done: boolean;
  repoPath: string | null;
}

export interface FoundEditor {
  id: string;
  name: string;
  path: string;
}

export interface FoundShell {
  id: string;
  name: string;
  path: string;
}

export interface GitConfigIdentity {
  name: string | null;
  email: string | null;
}

export interface GitConfigInfo {
  global: GitConfigIdentity;
  local: GitConfigIdentity;
  /** Effective values in the repository context (local overrides global). */
  effective: GitConfigIdentity;
}

export interface ConflictBlockResolution {
  id: number;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ConflictResolutionResult {
  path: string;
  ok: boolean;
  error: string | null;
  blocks: ConflictBlockResolution[];
  staged: boolean;
  model: string | null;
  provider: string | null;
  /** Content prior to resolution, so the user can undo. */
  original: string | null;
}

export interface CommitOptions {
  summary: string;
  description: string;
  coAuthors: { name: string; email: string }[];
  amend: boolean;
  /** Files (paths) to include. Files not listed are left out of the commit. */
  files: string[];
  /** Partial selections keyed by path: patch text to apply to the index instead of the whole file. */
  partialPatches: Record<string, string>;
}

export interface CloneOptions {
  url: string;
  directory: string;
  /** Branch to check out after cloning, optional. */
  branch: string | null;
}

export interface NewRepositoryOptions {
  name: string;
  directory: string;
  description: string;
  initializeWithReadme: boolean;
  gitignoreTemplate: string | null;
  license: string | null;
}

export interface PublishOptions {
  name: string;
  description: string;
  isPrivate: boolean;
  organization: string | null;
}

export interface CreatePullRequestOptions {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
  web: boolean;
}

export interface RebaseSquashOptions {
  /** SHAs to squash together (newest first as displayed). */
  shas: string[];
  /** SHA of the commit to squash into. */
  targetSha: string;
  message: string;
}

export interface GitErrorInfo {
  message: string;
  command: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  /** Machine friendly classification used by the renderer to pick a dialog. */
  code:
    | 'unknown'
    | 'not-a-repository'
    | 'auth-failed'
    | 'network'
    | 'non-fast-forward'
    | 'conflicts'
    | 'local-changes-overwritten'
    | 'protected-branch'
    | 'no-upstream'
    | 'nothing-to-commit'
    | 'lock-file'
    | 'remote-not-found'
    | 'branch-exists'
    | 'cancelled'
    | 'tool-missing'
    | 'gh-not-authenticated'
    | 'ai-not-configured';
}

export interface IpcFailure {
  ok: false;
  error: GitErrorInfo;
}

export interface IpcSuccess<T> {
  ok: true;
  value: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export interface AppInfo {
  version: string;
  electron: string;
  platform: string;
  userDataPath: string;
  logPath: string;
}

export interface MenuActionEvent {
  action: string;
  args?: unknown;
}

export interface RepositoryChangedEvent {
  repoPath: string;
  /** 'worktree' when files changed, 'refs' when .git metadata changed. */
  reason: 'worktree' | 'refs' | 'both';
}

export interface AiResolveProgressEvent {
  repoPath: string;
  path: string;
  phase: 'started' | 'thinking' | 'writing' | 'done' | 'error';
  message: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  externalEditor: null,
  customEditorPath: null,
  shell: null,
  customShellPath: null,
  defaultCloneDirectory: '',
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  confirmDiscardStash: true,
  confirmForcePush: true,
  confirmRepositoryRemoval: true,
  confirmUndoCommit: true,
  confirmCheckoutCommit: true,
  pullBehavior: 'git-config',
  uncommittedChangesStrategy: 'ask',
  autoFetchIntervalMinutes: 10,
  diffViewMode: 'unified',
  diffHideWhitespace: false,
  diffShowIntraline: true,
  diffWrapLines: false,
  diffFontSize: 12,
  diffSyntaxHighlighting: true,
  showCommitLengthWarning: true,
  repositoryIndicators: true,
  notifyPullRequestReviews: true,
  notifyPullRequestChecks: true,
  gitPath: null,
  ghPath: null,
  ai: {
    provider: 'anthropic',
    model: 'claude-opus-5',
    effort: 'high',
    hasApiKey: false,
    claudeCliPath: null,
    autoStageAfterResolve: true,
  },
};
