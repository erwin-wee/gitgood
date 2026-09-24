/**
 * Shared data types that cross the IPC boundary between the Electron main
 * process and the renderer. Keep this file free of Node or DOM specifics.
 */

export type Theme = 'system' | 'light' | 'dark';
export type DiffViewMode = 'unified' | 'split';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PullBehavior = 'git-config' | 'merge' | 'rebase';
export type UncommittedChangesStrategy = 'ask' | 'stash' | 'move';
export type UpdateChannel = 'stable' | 'beta';

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
  /** How many findings an AI code review should surface. */
  reviewStrictness: ReviewStrictness;
  /** Maximum number of files sent to the model in one review run. */
  reviewMaxFiles: number;
  /** Append an "AI-assisted" footer to reviews posted to GitHub. */
  reviewPostFooter: boolean;
  /** Automatically load an AI explanation when the error dialog opens for an unclassified ('unknown') error. Classified errors always require the explicit click. */
  explainErrorsAutomatically: boolean;
  /** Run the AI review automatically when Commit is clicked, and confirm with a dialog when it finds anything. Never blocks the commit. Default off. */
  reviewBeforeCommit: boolean;
  /** Terminal coding agent launched by "Fix with agent" on review findings; `custom` uses `agentCustomCommand`. Default 'claude'. */
  agentCommand: 'claude' | 'codex' | 'omp' | 'custom';
  /** Command template for `agentCommand: 'custom'`; `{file}` is replaced by the exported latest.md path. */
  agentCustomCommand: string;
  /** True once the one-time "findings are handed to the agent" notice was accepted. Not portable. */
  agentHandoffNoticeShown: boolean;
  /** Automatically refresh triage lines for pull requests whose cache went stale, instead of waiting for a manual Summarize click. Default off. */
  triageAutoRefresh: boolean;
  /** Include per-file addition/deletion counts (capped at 50 files) in pull request triage requests. Default on. */
  triageIncludeDiffStat: boolean;
  /** Audience the AI release notes generator writes for. Default 'users'. */
  releaseNotesAudience: 'users' | 'developers';
  /** Shell command run in the repository root after a successful AI conflict resolution (formatter, type checker, …); null disables it. Runs through the platform shell (the only place GitGood does so). */
  postResolveCheck: string | null;
  /** When on, a check command declared in the repository's `.gitgood/config.json` takes precedence over `postResolveCheck`, but only once the repository has been explicitly trusted (see `trustedRepoConfigs` in state.json). */
  postResolveCheckFromRepo: boolean;
  /** Shows the "Ask AI" row in the Ctrl+K command palette. Hidden (not disabled) along with the row when the AI provider is disabled. Default on. */
  nlPaletteEnabled: boolean;
}

export type ReviewStrictness = 'strict' | 'balanced' | 'thorough';

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
  confirmCloseIssue: boolean;
  confirmMarkAllNotificationsRead: boolean;
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
  /** Default directory for new worktrees; empty means a sibling of the repository. */
  defaultWorktreeDirectory: string;
  /** Skip commits that only changed whitespace when attributing blame lines. */
  blameIgnoreWhitespace: boolean;
  /** Days without a commit before the Repository health view calls a branch inactive. */
  staleBranchDays: number;
  /** Blob size, in bytes, at or above which the Repository health view and Welcome screen warn about a repository (also the default threshold used to decide whether a large blob should be tracked with LFS). */
  healthLargeFileThresholdBytes: number;
  /** Opt-in: show a warning dot on repository rows that have unpushed work (ahead branches, unpublished branches, stashes). */
  showUnpushedWorkIndicator: boolean;
  /** Verify commit signatures while loading History (adds %G?/%GS/%GK to the log format, which is slower on large histories). Default off. */
  historyVerifySignatures: boolean;
  /** Poll GitHub notifications for the Inbox. Defaults to on once signed in; has no effect while signed out. */
  notificationsEnabled: boolean;
  /** Minimum minutes between notification polls; the server's own X-Poll-Interval is honoured when it asks for longer. */
  notificationsPollIntervalMinutes: number;
  /** Desktop alert when a mention or team-mention notification arrives while the window is unfocused. */
  notifyMentions: boolean;
  /** Desktop alert when a review-request notification arrives while the window is unfocused. */
  notifyReviewRequests: boolean;
  /** Check the release feed on launch and every 6 hours; manual checks always work regardless. */
  checkForUpdatesAutomatically: boolean;
  /** Download an available update in the background once found. Reserved for a future updater backend; the built-in fallback checker never downloads, only offers a manual download link. */
  autoDownloadUpdates: boolean;
  /** Release channel: 'beta' also offers prereleases. Fixed in Options → Advanced, never part of the release feed URL (that is fixed in the build). */
  updateChannel: UpdateChannel;
  /**
   * Folders scanned for Git repositories on launch, on change, and on demand.
   * Machine-local: deliberately absent from PortablePreferences, so these paths
   * never leave the machine through a settings export or gist sync.
   */
  watchedFolders: WatchedFolder[];
  ai: AiSettings;
}

// ---------------------------------------------------------------------------
// Watched folders
// ---------------------------------------------------------------------------

/** A folder scanned for repositories, with how many levels below it may be examined (the folder itself is level 0). */
export interface WatchedFolder {
  /**
   * The physical path, with symbolic links (and Windows junctions) resolved.
   * Every comparison — scan root, exclusions, dropping vanished repositories —
   * uses this, because git reports repositories by their physical path.
   */
  path: string;
  /**
   * The path the user actually chose, when it differs from `path` — a symlink,
   * a junction or a mapped drive. Shown wherever a folder is named to the user,
   * so a row reads `~/Projects` rather than `/mnt/data/Projects`. Absent when
   * the chosen path was already physical.
   */
  displayPath?: string;
  /** 1–10; the deepest level below `path` that a scan examines. */
  depth: number;
}

/** The path to show the user for a watched folder: the one they chose, falling back to the physical path. */
export function watchedFolderLabel(folder: Pick<WatchedFolder, 'path' | 'displayPath'>): string {
  return folder.displayPath ?? folder.path;
}

export const WATCHED_FOLDER_MIN_DEPTH = 1;
export const WATCHED_FOLDER_MAX_DEPTH = 10;
export const WATCHED_FOLDER_DEFAULT_DEPTH = 3;

/** Why a watched folder cannot be scanned, shown against its row in Options. */
export type WatchedFolderProblem = 'missing' | 'not-a-directory' | 'unreadable';

export interface WatchedFolderStatus {
  path: string;
  problem: WatchedFolderProblem | null;
}

export interface RepositoryScanResult {
  added: number;
  /** Repositories found but already in the list, or excluded. */
  skipped: number;
  /** Repositories found that could not be registered (no longer a repository, or git failed). */
  failed: number;
  /** Directories that could not be read (permissions). */
  unreadable: number;
  /** Repositories dropped because their folder is gone; see the drop pass. */
  dropped: number;
  cancelled: boolean;
  /** Set when a scan was already running and this request did nothing. */
  alreadyRunning?: boolean;
  folders: WatchedFolderStatus[];
}

export interface RepositoryScanProgress {
  /** The watched folder currently being walked. */
  folder: string;
  /** Directories examined so far across the whole scan. */
  scanned: number;
  /** Repositories found so far across the whole scan. */
  found: number;
}

// ---------------------------------------------------------------------------
// Commit signing
// ---------------------------------------------------------------------------

export type SigningFormat = 'openpgp' | 'ssh' | 'x509';

export interface SigningConfig {
  format: SigningFormat | null;
  /** GPG key id, an SSH public key file path, or a pasted key in `key::<literal>` form. */
  key: string | null;
  signCommits: boolean;
  signTags: boolean;
  /** Custom signing program (`gpg.program` or `gpg.ssh.program`), when configured. */
  program: string | null;
  /** `gpg.ssh.allowedSignersFile`, for local verification of SSH signatures. */
  allowedSignersFile: string | null;
  /** Which scope actually supplies these values ('local' takes precedence over 'global'; 'none' when nothing is configured at the scope this value represents). */
  scope: 'local' | 'global' | 'none';
}

export interface SigningConfigInfo {
  local: SigningConfig;
  global: SigningConfig;
  /** Effective values in the repository context (local overrides global). */
  effective: SigningConfig;
}

export interface SigningKey {
  /** GPG long key id, or the SSH public key file path. */
  id: string;
  label: string;
  email: string | null;
  /** ISO date, or null when the key does not expire or expiry is unknown. */
  expires: string | null;
  kind: 'gpg' | 'ssh';
}

export type SignatureStatus = 'good' | 'bad' | 'unknown-key' | 'expired' | 'expired-key' | 'revoked' | 'untrusted' | 'none';

export interface CommitSignature {
  status: SignatureStatus;
  signer: string | null;
  keyId: string | null;
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
  /** Id of the main repository this is a linked worktree of, or null for an ordinary/main repository. */
  worktreeOf: string | null;
  /** Id of the repository this was opened from as a submodule ("Open as repository"), or null otherwise. */
  parentRepoId: string | null;
  /**
   * How this entry got into the list. Absent in repositories.json files written
   * before watched folders existed, and read as 'manual' — see repositoryOrigin().
   * Only a watched-folder scan writes 'watched'; a repository the user added by
   * hand keeps 'manual' even when a scan later finds it in a watched folder.
   */
  origin?: 'manual' | 'watched';
}

/** `RepositoryInfo.origin` with the default applied: entries written before watched folders existed are manual. */
export function repositoryOrigin(repo: Pick<RepositoryInfo, 'origin'>): 'manual' | 'watched' {
  return repo.origin === 'watched' ? 'watched' : 'manual';
}

/** One entry from `git worktree list`, including the main worktree. */
export interface Worktree {
  path: string;
  /** HEAD commit SHA. */
  head: string;
  /** Checked-out branch (without refs/heads/ prefix), or null when detached. */
  branch: string | null;
  isMain: boolean;
  /** True when this is the worktree the caller asked about. */
  isCurrent: boolean;
  /** Non-null when locked; empty string when locked without a reason. */
  locked: string | null;
  /** Non-null when git considers the entry prunable, with git's reason. */
  prunable: string | null;
  /** Uncommitted changes; null until computed (computed lazily while the dialog is open). */
  dirty: boolean | null;
}

export interface AddWorktreeOptions {
  /** Directory to create the worktree in. */
  path: string;
  /** Check out this existing branch (local or remote-tracking). */
  branch: string | null;
  /** Create this new branch in the worktree. */
  newBranch: string | null;
  /** Start point for `newBranch`, or the commit to detach at. */
  startPoint: string | null;
  /** Check out a detached HEAD at `startPoint`/the current branch tip instead of a branch. */
  detach: boolean;
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
  /** True when this path is tracked by an LFS `filter=lfs` attribute. */
  lfs: boolean;
}

// ---------------------------------------------------------------------------
// Submodules
// ---------------------------------------------------------------------------

export type SubmoduleState = 'up-to-date' | 'uninitialized' | 'modified' | 'differs' | 'conflicted' | 'missing';

export interface Submodule {
  /** Repository-relative path, using forward slashes. */
  path: string;
  name: string;
  /** URL as configured, resolved against the superproject's origin when relative. */
  url: string;
  /** Commit recorded in the superproject's HEAD, or null when it cannot be determined. */
  recordedSha: string | null;
  /** Commit currently checked out in the submodule's worktree, or null when uninitialized. */
  checkedOutSha: string | null;
  state: SubmoduleState;
  /** True when this is a submodule of a submodule (nested, not listed directly in the top-level .gitmodules). */
  nested: boolean;
}

// ---------------------------------------------------------------------------
// Git LFS
// ---------------------------------------------------------------------------

export interface LfsStatus {
  installed: boolean;
  version: string | null;
  /** True when the repository's local pre-push hook invokes git-lfs. */
  hooksInstalled: boolean;
  /** True when any `.gitattributes` in the repository declares a `filter=lfs` pattern. */
  usedByRepo: boolean;
  /** Tracked glob patterns, e.g. `*.psd`. */
  patterns: string[];
  trackedFiles: number;
  /** Bytes of LFS objects present locally, or null when git-lfs is not installed. */
  localBytes: number | null;
  missingFiles: number;
}

export interface LfsFile {
  path: string;
  oid: string;
  size: number | null;
  /** True when the object has been downloaded locally. */
  present: boolean;
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
  /** True when the branch has an upstream configured but it was deleted (git's `[gone]` marker). */
  upstreamGone: boolean;
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
  /** Number of files carried by the stash, or null when not yet known (very large stash lists). */
  fileCount: number | null;
  /** True when the stash carries untracked files (created with `git stash -u`). */
  untracked: boolean;
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
  /** Non-null only when the history request opted into signature verification (see HistoryOptions.verifySignatures). */
  signature: CommitSignature | null;
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  status: FileStatusKind;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** True when this path is tracked by an LFS `filter=lfs` attribute. */
  lfs: boolean;
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

/**
 * Structured filters extracted from the History search box's `key:value`
 * syntax (see `parseHistoryQuery`/`formatHistoryQuery` in shared/util.ts) and
 * mirrored by the filter popover.
 */
export interface HistoryQuery {
  /** Pickaxe text (`-S`): commits whose diff added or removed this text. */
  content: string | null;
  /** When true, `content` is matched with `--pickaxe-regex` instead of a literal string. */
  contentRegex: boolean;
  /** Diff regex (`-G`): commits whose diff has a line matching this expression. */
  diffRegex: string | null;
  paths: string[];
  author: string | null;
  after: string | null;
  before: string | null;
  /** Search every branch, tag and remote (`--all`) instead of just the current branch. */
  allRefs: boolean;
}

export const EMPTY_HISTORY_QUERY: HistoryQuery = { content: null, contentRegex: false, diffRegex: null, paths: [], author: null, after: null, before: null, allRefs: false };

// ---------------------------------------------------------------------------
// Blame & file history
// ---------------------------------------------------------------------------

/** SHA git uses to mark a line that has not been committed yet. */
export const ZERO_SHA = '0000000000000000000000000000000000000000';

/** Blame is not computed for files with more lines than this. */
export const BLAME_MAX_LINES = 20_000;

/** `repo.fileAtCommit` refuses to return content larger than this. */
export const FILE_AT_COMMIT_MAX_BYTES = 2 * 1024 * 1024;

/** One contiguous run of lines attributed to the same commit. */
export interface BlameHunk {
  sha: string;
  shortSha: string;
  author: Identity;
  summary: string;
  /** Path of the file at `sha`, which may differ from the path being blamed when it was later renamed. */
  originalPath: string;
  /** 1-based line number (in the blamed content) where this run starts. */
  startLine: number;
  lineCount: number;
  /** Parent commit to re-blame at ("Blame at parent"), or null for a root commit or uncommitted lines. */
  previousSha: string | null;
}

export interface BlameResult {
  path: string;
  /** Revision blamed, or null for the working tree. */
  rev: string | null;
  hunks: BlameHunk[];
  /** Full text content that was blamed, or null when binary/too large. */
  content: string | null;
  language: string | null;
  lineCount: number;
  /** True when the file exceeds BLAME_MAX_LINES; hunks/content are empty/null. */
  tooLarge: boolean;
  binary: boolean;
  /** True when the repository is a shallow clone, so attribution may stop early. */
  shallow: boolean;
}

export interface FileAtCommitResult {
  /** File content, or null when binary or larger than FILE_AT_COMMIT_MAX_BYTES. */
  content: string | null;
  binary: boolean;
  bytes: number;
}

/** The path a tracked file had at a given commit, following renames (from `repo.pathHistory`). */
export interface PathHistoryEntry {
  sha: string;
  path: string;
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
      /** Full old-side content only when the new side is absent (for pure deletions or capped new content). */
      oldContent: string | null;
      hasCRLF: boolean;
    }
  | { kind: 'binary'; oldBytes: number | null; newBytes: number | null }
  | { kind: 'image'; oldImage: ImagePayload | null; newImage: ImagePayload | null }
  | { kind: 'submodule'; oldSha: string | null; newSha: string | null; summary: string }
  | { kind: 'lfs'; path: string; oldOid: string | null; newOid: string | null; size: number; present: boolean; inner: FileDiff | null }
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
  /** Commit SHA at the tip of the head branch, when gh reports it. */
  headSha: string | null;
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
  /** Per-file addition/deletion counts, as reported by `gh pr list`'s `files` field. */
  filesChanged: { path: string; additions: number; deletions: number }[];
  /** Total number of reviews left on the pull request (including stale ones superseded by a later review). */
  reviewsCount: number;
  /** The latest review left by each reviewer. */
  latestReviews: { author: string; state: string }[];
  /** Number of issue-style comments on the pull request (not review comments). */
  commentsCount: number;
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
  gitLfs: ToolInfo;
  gpg: ToolInfo;
  sshKeygen: ToolInfo;
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

// ---------------------------------------------------------------------------
// GitHub issues
// ---------------------------------------------------------------------------

export interface Issue {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  author: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  body: string;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
  url: string;
}

export interface IssueDetail extends Issue {
  comments: IssueComment[];
}

export interface IssueFilter {
  search: string;
  state: 'open' | 'closed' | 'all';
  assignee: 'any' | 'me';
  author: 'any' | 'me';
  mentioned: boolean;
  labels: string[];
  milestone: string | null;
}

export const DEFAULT_ISSUE_FILTER: IssueFilter = { search: '', state: 'open', assignee: 'any', author: 'any', mentioned: false, labels: [], milestone: null };

export interface IssueTemplate {
  name: string;
  about: string | null;
  title: string | null;
  labels: string[];
  body: string;
  /** True for a GitHub Issue Forms YAML template; GitGood does not render these, selecting one opens the browser's new-issue flow with this template preselected instead of filling the in-app form. */
  external: boolean;
  /** File name under .github/ISSUE_TEMPLATE/, used to build the `?template=` query string for external templates. */
  filename: string;
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

// ---------------------------------------------------------------------------
// GitHub notifications inbox
// ---------------------------------------------------------------------------

export type NotificationReason =
  | 'review_requested'
  | 'ci_activity'
  | 'mention'
  | 'assign'
  | 'comment'
  | 'author'
  | 'state_change'
  | 'subscribed'
  | 'team_mention'
  | 'security_alert'
  | 'other';

export type InboxSubjectType = 'PullRequest' | 'Issue' | 'Release' | 'Discussion' | 'CheckSuite' | 'Other';

export interface InboxItem {
  /** GitHub notification id; also used as the thread id for read/unsubscribe actions. */
  id: string;
  threadId: string;
  repo: GitHubRepoRef;
  /** Id of the matching entry in the app's repository list, or null when the repository is not known to the app. */
  localRepoId: string | null;
  subject: {
    type: InboxSubjectType;
    title: string;
    /** Web URL to open in place (pull requests/issues/discussions) or in the browser; null when it cannot be derived. */
    url: string | null;
    number: number | null;
  };
  reason: NotificationReason;
  unread: boolean;
  updatedAt: string;
  lastReadAt: string | null;
}

export type InboxPauseReason = 'rate-limit' | 'scope' | 'offline';

export interface InboxState {
  items: InboxItem[];
  unreadCount: number;
  lastPolledAt: string | null;
  paused: InboxPauseReason | null;
  /** ISO timestamp the pause is expected to clear, known only for 'rate-limit'. */
  pausedUntil: string | null;
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

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/**
 * State machine for the updater. `available` is reached by any provider;
 * `downloading`/`ready` are only reached by a provider that implements
 * `startDownload`/`quitAndInstall` (currently `ElectronUpdaterProvider` — see
 * src/main/update/provider.ts). A provider without those (e.g. a manual-link
 * fallback) never leaves `available` except back to `up-to-date`/`error`.
 */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'disabled'; reason: string; manualUrl: string | null }
  | { status: 'available'; version: string; releaseDate: string | null; notes: string | null; url: string; prerelease: boolean; dismissed: boolean }
  | { status: 'downloading'; version: string; releaseDate: string | null; notes: string | null; url: string; prerelease: boolean; percent: number | null; bytesPerSecond: number | null }
  | { status: 'ready'; version: string; releaseDate: string | null; notes: string | null; url: string; prerelease: boolean }
  | { status: 'error'; message: string; manualUrl: string | null };

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
  /** 0-based, half-open line range this block's resolved text occupies in the written file (see applyResolutions in shared/diff/conflicts.ts). */
  range: { start: number; end: number };
}

/** Outcome of running the configured post-resolution check command (see AiSettings.postResolveCheck/postResolveCheckFromRepo). */
export interface PostResolveCheckResult {
  command: string;
  /** True when the source of the command is the repository's `.gitgood/config.json` rather than the user's own setting. */
  fromRepo: boolean;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout/stderr tail, capped at 4,000 characters. */
  outputTail: string;
  durationMs: number;
}

/** A worked example built from a manual conflict resolution in the current operation, sent to the model on a guided run (see AiSettings/resolveAllGuided). */
export interface ManualResolutionExample {
  path: string;
  /** Trimmed to the conflict blocks plus surrounding context (see resolve-examples.ts); not the full original file. */
  original: string;
  /** Same trimming applied to the resolved text. */
  resolved: string;
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
  /** Result of the post-resolution check, or null when none is configured. */
  check: PostResolveCheckResult | null;
  /** Paths of the manually resolved files used as worked examples for this run, or an empty array for a non-guided run. */
  guidedBy: string[];
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
  /** 'default' follows the repository's signing configuration; 'sign' forces -S; 'unsigned' forces --no-gpg-sign for this commit only (never persisted). */
  signOverride?: 'default' | 'sign' | 'unsigned';
}

// ---------------------------------------------------------------------------
// AI commit splitting
// ---------------------------------------------------------------------------

/** One hunk offered to the AI commit splitter, identified by a content-derived id stable across the hunk's position shifting as sibling hunks in the same file are committed away (see stableHash in src/main/ai/review-core.ts, reused by src/main/ai/splitter-core.ts). */
export interface SplitHunk {
  id: string;
  path: string;
  /** Index into that file's current working-diff hunks array at the time this SplitHunk was produced; not stable once earlier commits in the same plan land, so apply always re-resolves by id, never by this index. */
  hunkIndex: number;
  header: string;
  additions: number;
  deletions: number;
}

export interface SplitPlanCommit {
  id: string;
  summary: string;
  description: string;
  hunkIds: string[];
  /** Whole-file paths (untracked, renamed, deleted, typechange, submodule, binary/image, or a hunk-bearing file whose whole-file assignment was converted to its hunk ids). */
  wholeFiles: string[];
  rationale: string;
}

export interface SplitPlan {
  id: string;
  /** HEAD at plan time. Undo resets to this commit; only offered while it is still an ancestor of HEAD. */
  startSha: string;
  /** git hash-object (or SPLIT_DELETED_HASH for a file that does not exist in the working tree) per included path, recorded at plan time; apply refuses on any mismatch. */
  fileHashes: Record<string, string>;
  hunks: SplitHunk[];
  commits: SplitPlanCommit[];
  /** Hunk ids and whole-file paths the model left out of every commit; the dialog always shows these in a "Not included" bucket and never commits them silently. */
  unassigned: string[];
  warnings: string[];
  model: string;
}

/** Fast, non-AI summary of what a split would include, shown before the model is ever called. */
export interface SplitPreflight {
  fileCount: number;
  hunkCount: number;
  wholeFileOnly: { path: string; reason: string }[];
  excluded: { path: string; reason: string }[];
  estimatedBytes: number;
  /** True when estimatedBytes exceeds the prompt budget (150,000 bytes); the pre-flight then offers a file-only (headers/stats, no line bodies) split. */
  oversized: boolean;
}

export interface SplitApplyProgress {
  planId: string;
  index: number;
  total: number;
  sha: string | null;
  phase: 'staging' | 'committing' | 'done' | 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// AI rebase assistant ("Tidy up branch with AI")
// ---------------------------------------------------------------------------

export type RebasePlanAction = 'pick' | 'squash' | 'reword' | 'drop';

/** One row of an AI-proposed interactive-rebase todo, identified by the commit's original sha at plan time (stable identity; the live sha changes as steps apply). */
export interface RebasePlanRow {
  sha: string;
  action: RebasePlanAction;
  /** Original sha of an earlier pick/reword row this one folds into; only meaningful when action is 'squash'. */
  squashInto: string | null;
  originalMessage: string;
  message: string;
  rationale: string;
  /** True when this commit is already reachable from a remote branch. */
  pushed: boolean;
}

export interface RebasePlan {
  id: string;
  /** The resolved ref/sha the plan's range starts after (base..HEAD), shown and editable in the pre-flight. */
  base: string;
  /** HEAD at plan time. Undo/abort reset to this commit. */
  startSha: string;
  rows: RebasePlanRow[];
  /** The commit shas of the range in their pre-plan order, so a reorder can be detected by comparing against `rows`. */
  originalOrder: string[];
  /** Repair warnings from validating the model's proposal (omissions, invalid squash targets, downgraded drops, …). */
  warnings: string[];
  /** True when every row is pick with an unchanged message and the original order — nothing to apply. */
  alreadyTidy: boolean;
  /** True when the commit range exceeded the planning input caps (60 commits / 8,000 per patch / 120,000 total bytes). */
  truncated: boolean;
  model: string;
}

/** Fast, non-AI summary shown before the model is ever called. */
export interface RebasePreflight {
  /** The base ref/branch name as typed (or defaulted), before resolution. */
  base: string;
  /** The resolved ref/sha, or null when `base` does not resolve to a commit. */
  resolvedBase: string | null;
  /** Commits ahead of the resolved base (base..HEAD). */
  count: number;
  /** How many of those commits are already reachable from a remote branch. */
  pushedCount: number;
  /** True when a merge commit is in range; the assistant cannot rewrite across it. */
  hasMergeCommit: boolean;
}

export interface RebaseApplyProgress {
  planId: string;
  step: number;
  total: number;
  phase: 'drop' | 'reword' | 'reorder' | 'squash' | 'done' | 'error' | 'conflicts';
  message: string;
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
    | 'ai-not-configured'
    | 'stash-missing'
    | 'worktree-branch-in-use'
    | 'signing-failed'
    | 'signing-key-missing'
    | 'rate-limited'
    | 'split-stale'
    | 'unsupported';
  /** ISO timestamp when a rate limit resets, when known (code 'rate-limited' only). */
  rateLimitResetAt?: string | null;
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

// ---------------------------------------------------------------------------
// AI pull request review
// ---------------------------------------------------------------------------

export type ReviewSeverity = 'blocker' | 'warning' | 'nit';
export type ReviewCategory = 'bug' | 'security' | 'performance' | 'test-gap' | 'readability' | 'docs' | 'style' | 'intent-mismatch';
export type ReviewVerdict = 'approve' | 'comment' | 'request-changes';

export interface ReviewFinding {
  /** Stable id derived from path, line and title. */
  id: string;
  /** New-side path as it appears in the diff. */
  path: string;
  /** New-side line number; always an add or context line present in the diff. */
  line: number;
  endLine: number | null;
  severity: ReviewSeverity;
  category: ReviewCategory;
  title: string;
  detail: string;
  /** Replacement code for [line, endLine]: raw lines, no fences. */
  suggestion: string | null;
  confidence: 'high' | 'medium' | 'low';
  dismissed: boolean;
}

/** What the user asked to review. Resolved into a ReviewRunTarget with SHAs when a run starts. */
export type ReviewTarget = { kind: 'pr'; number: number } | { kind: 'branch'; base: string };

/**
 * A pre-commit review target: the exact patch `git.commit` would apply.
 * `paths` are every file included in the pending commit (new-side paths;
 * renamed files also carry their old path so the reviewer can tell them
 * apart, but `paths` here only lists the new/current path once).
 * `partialPaths` is the subset with a partial line selection.
 * `indexSha` is the tree hash of a temporary index built from the same
 * selection, used as a cheap whole-run staleness check.
 */
export interface WorktreeReviewTarget {
  kind: 'worktree';
  paths: string[];
  partialPaths: string[];
  indexSha: string;
}

export type ReviewRunTarget = { kind: 'pr'; number: number; headSha: string; baseSha: string; title: string; url: string } | { kind: 'branch'; base: string; head: string; headSha: string; baseSha: string } | WorktreeReviewTarget;

export type ReviewFileStatus = 'reviewed' | 'skipped' | 'failed' | 'cancelled' | 'pending';

export interface ReviewFileEntry {
  file: CommitFile;
  status: ReviewFileStatus;
  reason: string | null;
  /** Hash of the file's hunks so a re-review can skip files that did not change. */
  hash: string | null;
}

export interface ReviewRun {
  id: string;
  repoPath: string;
  target: ReviewRunTarget;
  startedAt: string;
  finishedAt: string | null;
  model: string;
  provider: string;
  effort: EffortLevel;
  strictness: ReviewStrictness;
  summary: string;
  verdict: ReviewVerdict | null;
  findings: ReviewFinding[];
  files: ReviewFileEntry[];
  /** Findings rejected by validation (line not in diff, malformed, …). */
  droppedInvalid: number;
  error: string | null;
  cancelled: boolean;
  /** True when the signed-in user authored the pull request (GitHub only allows COMMENT reviews). */
  ownPullRequest: boolean;
  /** Pre-commit reviews only: whether the diff appears to match the typed commit summary/description; null when not evaluated (non-worktree runs, or the run produced no summary). */
  commitMessageMatches: boolean | null;
  /** One sentence explaining a commitMessageMatches: false verdict; empty string otherwise. */
  commitMessageNote: string;
}

/** Input for `ai.review.startWorktree`: reviews the exact patch the pending commit would apply. */
export interface WorktreeReviewOptions {
  /** Path of every WorkingFile included in the commit (one entry per file; renames use their current path). */
  files: string[];
  /** Partial selections keyed by path, same shape as CommitOptions.partialPatches. */
  partialPatches: Record<string, string>;
  summary: string;
  description: string;
  /** Whether "Amend last commit" is checked; reviews against HEAD~1 instead of HEAD. Ignored while a merge is in progress (the index is reviewed instead either way). */
  amend: boolean;
  /** Restrict the run to these paths (used by "Re-review stale files"); omit to review every included file. */
  only?: string[];
  /** Previous run id to carry over findings for files whose content hash is unchanged. */
  rereviewOf?: string;
}

export interface ReviewPlan {
  /** Never 'worktree': a plan is only ever produced for a pr/branch ReviewTarget. */
  target: Exclude<ReviewRunTarget, WorktreeReviewTarget>;
  files: ReviewFileEntry[];
  changedLines: number;
  model: string;
  provider: string;
  effort: EffortLevel;
  strictness: ReviewStrictness;
  maxFiles: number;
  ownPullRequest: boolean;
  /** Present when a previous run exists for this target. */
  previousRun: { id: string; headSha: string; finishedAt: string | null } | null;
}

export interface ReviewStartOptions {
  /** Restrict the run to these paths (from the pre-flight card). */
  files?: string[];
  /** Re-review: carry over findings for files whose diff is unchanged since this run. */
  rereviewOf?: string;
}

export interface PostReviewOptions {
  runId: string;
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  body: string;
  findingIds: string[];
}

export interface AiReviewProgressEvent {
  repoPath: string;
  runId: string;
  phase: 'preparing' | 'file' | 'summarizing' | 'done' | 'error' | 'cancelled';
  path: string | null;
  index: number;
  total: number;
  message: string;
}

// ---------------------------------------------------------------------------
// AI pull request draft
// ---------------------------------------------------------------------------

export interface PrDraftInput {
  base: string;
  head: string;
  existingTitle: string;
  existingBody: string;
}

export interface PrDraftLinkedIssue {
  number: number;
  keyword: 'closes' | 'refs';
}

export interface PrDraft {
  title: string;
  body: string;
  linkedIssues: PrDraftLinkedIssue[];
  /** Heading text (as it appears in the template) of every section the model filled; empty when there is no template. */
  templateSectionsFilled: string[];
  /** True when the diff sent to the model was truncated by the size cap. */
  truncated: boolean;
  /** True when the model's body did not preserve the template's headings and the body was rebuilt around them. */
  restored: boolean;
  model: string;
}

// ---------------------------------------------------------------------------
// AI release notes
// ---------------------------------------------------------------------------

/** A commit range for release notes: `from` is exclusive and null means "from the root commit" (no reachable tag). */
export interface ReleaseRange {
  from: string | null;
  to: string;
}

export interface ReleaseCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** Empty when the range was truncated (subjects-only mode). */
  body: string;
  /** Empty when the range was truncated (subjects-only mode). */
  author: string;
  /** Empty when the range was truncated (subjects-only mode). */
  date: string;
  /** Pull request number this commit's own subject cites (a squash-merge subject ending "(#N)"), or null. */
  prNumber: number | null;
}

export interface ReleasePr {
  number: number;
  title: string;
  labels: string[];
  author: string;
  url: string;
}

/** Query for `repo.release.range`: `from: null` asks GitGood to pick the default (the latest reachable tag, or the root commit). */
export interface ReleaseRangeQuery {
  from: string | null;
  to: string;
  includePrs: boolean;
}

export interface ReleaseRangeResult {
  range: ReleaseRange;
  /** Non-merge commits in the range, newest first. */
  commits: ReleaseCommit[];
  /** Pull requests referenced by merge or squash-merge commit subjects in the range, each listed once, with titles when they could be fetched. */
  prs: ReleasePr[];
  /** Latest tag reachable from HEAD, or null when the repository has no tags. */
  latestTag: string | null;
  /** True when `range.from` is null because the repository has no tags (the range starts at the root commit). */
  rootFallback: boolean;
  /** True when the range exceeded the commit cap; gathering fell back to subjects only. */
  truncated: boolean;
  /** Compact `--stat=120` summary of the range, capped at 200 lines. */
  diffStat: string;
}

export interface ReleaseNotesInput {
  range: ReleaseRange;
  version: string;
  audience: 'users' | 'developers';
  includePrs: boolean;
}

export interface ReleaseNotesItem {
  text: string;
  /** "#123" or a short commit SHA, already validated against the range. */
  refs: string[];
}

export interface ReleaseNotesSection {
  title: string;
  items: ReleaseNotesItem[];
}

/** A commit or PR the notes cite nowhere, or a model item whose only references were invalid (then `ref` is null: there is nothing valid to re-attach). */
export interface ReleaseNotesUnreferencedEntry {
  text: string;
  ref: string | null;
}

export interface ReleaseNotes {
  version: string;
  markdown: string;
  sections: ReleaseNotesSection[];
  unreferenced: ReleaseNotesUnreferencedEntry[];
  truncated: boolean;
  model: string;
}

export interface CreateReleaseOptions {
  tag: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** Commit to create the tag at, when it does not exist yet; null when the tag already exists. */
  targetSha: string | null;
}

// ---------------------------------------------------------------------------
// AI diff explanation
// ---------------------------------------------------------------------------

/** What an explanation is rooted in: a commit, the working tree, or a stash. */
export type ExplainSource = { kind: 'commit'; sha: string } | { kind: 'working' } | { kind: 'stash'; ref: string };

/** What the user asked to have explained. */
export type ExplainTarget =
  | { kind: 'commit'; sha: string }
  | { kind: 'file'; source: ExplainSource; path: string }
  | { kind: 'range'; source: ExplainSource; path: string; hunkIndex: number; startLine: number; endLine: number };

export interface ExplainReference {
  /** New-side path, as it appears in the explained target. */
  path: string;
  /** New-side line number, or null for a reference to the whole file. */
  line: number | null;
  label: string;
}

export interface Explanation {
  whatChanged: string;
  /** Inferred intent; kept visibly separate from whatChanged in the UI. */
  why: string;
  impact: string;
  watchOutFor: string[];
  references: ExplainReference[];
  /** True when the input was too large and some files/lines were left out. */
  truncated: boolean;
  /** References the model proposed that did not resolve to a real path/line in the target and were dropped. */
  droppedReferences: number;
  model: string;
}

export interface ExplainFollowUp {
  question: string;
  answer: string;
}

/** Maximum follow-up questions per explanation; enforced in both the renderer and main. */
export const EXPLAIN_FOLLOWUP_LIMIT = 5;

// ---------------------------------------------------------------------------
// AI error explanation
// ---------------------------------------------------------------------------

/**
 * Actions an AI-suggested fix may name. Each id maps onto an operation
 * GitGood already exposes elsewhere in the UI (see the action table in
 * src/main/ai/fixActions.ts and the dispatch in
 * src/renderer/src/state/actions.ts's applyErrorFix). Anything else the
 * model names is downgraded to a copy-only command or dropped; the model
 * never gains a new way to run something GitGood would not otherwise run.
 */
export type FixActionId =
  | 'fetch'
  | 'pull'
  | 'fetch-and-pull'
  | 'push-set-upstream'
  | 'force-push-with-lease'
  | 'stash-and-retry'
  | 'discard-and-retry'
  | 'remove-lock-file'
  | 'abort-merge'
  | 'abort-rebase'
  | 'abort-cherry-pick'
  | 'abort-revert'
  | 'continue-rebase'
  | 'open-sign-in'
  | 'open-remote-settings'
  | 'open-identity-settings'
  | 'rename-branch'
  | 'open-in-terminal';

export type FixRisk = 'safe' | 'changes-history' | 'discards-work' | 'touches-remote';

export interface ErrorFix {
  label: string;
  detail: string;
  /** One of the fixed actions above, or null for a copy-only command. */
  action: FixActionId | null;
  /** A single `git`/`gh` command, shown with a copy button and "Run in terminal" (which never executes it). Present only for copy-only fixes. */
  command: string | null;
  /** Retry the operation that failed once this fix completes. Only ever honoured when the failed operation supplied a retry callback. */
  retryAfter: boolean;
  risk: FixRisk;
}

export interface ErrorExplanation {
  whatHappened: string;
  likelyCause: string;
  /** At most 3, ordered least to most destructive; validated and policy-filtered against the live repository state before this reaches the renderer. */
  fixes: ErrorFix[];
  model: string;
}

// ---------------------------------------------------------------------------
// AI pull request triage
// ---------------------------------------------------------------------------

export type TriageState = 'waiting-on-you' | 'waiting-on-author' | 'waiting-on-others' | 'checks-failing' | 'ready-to-merge' | 'draft' | 'stale' | 'conflicts';

export type TriageNextAction = 'review' | 'checkout' | 'view-checks' | 'merge' | 'rebase' | 'ping-author' | 'none';

/** A cached AI triage line for one pull request, keyed by its number in the per-repository cache file. */
export interface PrTriage {
  number: number;
  /** The pull request's `updatedAt` at the time this line was generated; a mismatch means the cache is stale. */
  updatedAt: string;
  headSha: string | null;
  /** One-sentence summary, at most 140 characters. */
  summary: string;
  state: TriageState;
  /** At most 200 characters, explaining the state. */
  reason: string;
  nextAction: TriageNextAction;
  model: string;
  generatedAt: string;
}

export interface AiTriageProgressEvent {
  repoPath: string;
  done: number;
  total: number;
}

// ---------------------------------------------------------------------------
// AI command palette (natural-language to git plan)
// ---------------------------------------------------------------------------

/** Risk classification for a natural-language palette step, shared by the model's own guess and the policy's independently recomputed value (the higher of the two is shown). */
export type NlRisk = 'safe' | 'changes-history' | 'discards-work' | 'touches-remote';

/**
 * One step of a natural-language plan after the pure policy in
 * src/main/ai/nlPolicy.ts has evaluated it. `argv` is exactly what the model
 * proposed (a `git ...` command, leading `git` included as returned by the
 * model); `mappedAction` names the `ApiMethods` key (or the special value
 * 'git.tryRun' for a read-only inspect command) GitGood will call when the
 * step runs, and is null whenever `executable` is false.
 */
export interface NlStep {
  id: string;
  argv: string[];
  /** `argv` joined with spaces, for display and Copy commands. */
  display: string;
  explanation: string;
  /** The higher of the model's own classification and the policy's independently recomputed one. */
  risk: NlRisk;
  /** False for anything not covered by the strict allowlist, denylisted, or referring to something that does not exist; shown greyed with `refusalReason` and a copy action. */
  executable: boolean;
  refusalReason: string | null;
  preview: { title: string; lines: string[] } | null;
  /** An `ApiMethods` key (e.g. "git.checkout"), or "git.tryRun" for a read-only inspect step; null when `executable` is false. */
  mappedAction: string | null;
  /** Typed arguments for `mappedAction`, in the order the underlying wrapper expects (excluding `repoPath`, which the runner supplies); empty when `executable` is false. */
  mappedArgs: unknown[];
}

export interface NlPlan {
  id: string;
  request: string;
  steps: NlStep[];
  /** Present only when the model asked a single clarifying question instead of returning steps; `steps` is then empty. */
  clarifyingQuestion: string | null;
  model: string;
}

export interface NlRunResult {
  planId: string;
  /** Step ids executed successfully, in order. */
  completed: string[];
  /** The step id that failed, or null when every requested step completed (or none were confirmed). */
  failedStep: string | null;
  error: GitErrorInfo | null;
}

export interface NlProgressEvent {
  repoPath: string;
  planId: string;
  stepId: string;
  phase: 'running' | 'done' | 'error' | 'awaiting-confirmation';
}

// ---------------------------------------------------------------------------
// Repository health
// ---------------------------------------------------------------------------

/** One of the 25 largest blobs ever committed to the repository. */
export interface LargeBlob {
  /** Path the blob was found at while walking history (its first-seen path; a blob may have lived at several paths). */
  path: string;
  sha: string;
  size: number;
  /** Commit that first added `path`, when it could be determined. */
  firstCommitSha: string | null;
  firstCommitDate: string | null;
  /** True when this exact blob is still the content at `path` in HEAD. */
  atHead: boolean;
  /** True when `path` matches a `filter=lfs` pattern already declared in the repository. */
  wouldBeLfs: boolean;
}

export type StaleBranchReason = 'merged' | 'inactive' | 'gone';

export interface StaleBranch {
  name: string;
  reason: StaleBranchReason[];
  sha: string;
  lastCommitDate: string;
  upstream: string | null;
  isCurrent: boolean;
  isDefault: boolean;
  /** Current, default or otherwise known-protected; never offered for deletion. */
  protected: boolean;
}

export interface BranchDeleteResult {
  deleted: { name: string; sha: string }[];
  failed: { name: string; message: string }[];
}

/** Unpushed work in one repository, for the Unpushed work card and the Welcome screen. */
export interface RepoWork {
  repoId: string;
  repoPath: string;
  repoName: string;
  aheadBranches: { name: string; ahead: number }[];
  unpublishedBranches: string[];
  stashCount: number;
  uncommittedCount: number;
}

export interface Housekeeping {
  /** Total size of the `.git` directory, in bytes. */
  gitDirBytes: number;
  looseObjectCount: number;
  looseObjectBytes: number;
  packCount: number;
  packBytes: number;
  garbageCount: number;
  garbageBytes: number;
  /** Timestamp (ms) of the newest pack file, used as a proxy for when `git gc` last ran, or null when never. */
  lastGcAt: number | null;
}

// ---------------------------------------------------------------------------
// Settings export, import and gist sync
// ---------------------------------------------------------------------------

export type SettingsSection = 'preferences' | 'repositories' | 'integrations';

/** Fields of AppSettings['ai'] that are safe to export: never the stored-key flag or the CLI path (both machine/secret specific). */
export type PortableAiSettings = Pick<AiSettings, 'provider' | 'model' | 'effort' | 'autoStageAfterResolve' | 'reviewStrictness' | 'reviewMaxFiles' | 'reviewPostFooter' | 'agentCommand' | 'agentCustomCommand'>;

/**
 * Explicit allowlist of AppSettings fields that may leave the machine (a
 * file export or a sync gist). Never add a field here without checking that
 * it is not a secret, a per-machine tool path, or window/geometry state.
 * `PREFERENCE_KEYS` in src/main/settings/sync-core.ts is checked at compile
 * time against this type, so adding a field here without also adding it
 * there is a type error (and vice versa).
 */
export interface PortablePreferences {
  theme: Theme;
  confirmDiscardChanges: boolean;
  confirmDiscardChangesPermanently: boolean;
  confirmDiscardStash: boolean;
  confirmForcePush: boolean;
  confirmRepositoryRemoval: boolean;
  confirmUndoCommit: boolean;
  confirmCheckoutCommit: boolean;
  confirmCloseIssue: boolean;
  confirmMarkAllNotificationsRead: boolean;
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
  defaultCloneDirectory: string;
  defaultWorktreeDirectory: string;
  blameIgnoreWhitespace: boolean;
  staleBranchDays: number;
  healthLargeFileThresholdBytes: number;
  showUnpushedWorkIndicator: boolean;
  historyVerifySignatures: boolean;
  notificationsEnabled: boolean;
  notificationsPollIntervalMinutes: number;
  notifyMentions: boolean;
  notifyReviewRequests: boolean;
  ai: PortableAiSettings;
}

/** `externalEditor`/`shell` hold an id ('code', 'custom', …); the `custom*Path` fields are filesystem paths and are skipped on import when the file's platform differs from this machine's. */
export interface PortableIntegrations {
  externalEditor: string | null;
  customEditorPath: string | null;
  shell: string | null;
  customShellPath: string | null;
}

export interface PortableRepository {
  /** Forward-slash path as recorded on the exporting machine. */
  path: string;
  alias: string | null;
  github: GitHubRepoRef | null;
}

export interface SettingsExport {
  schema: 1;
  app: 'gitgood';
  /** GitGood version that produced this file (informational only; import does not require a match). */
  version: string;
  exportedAt: string;
  /** `process.platform` of the exporting machine ('darwin' | 'win32' | 'linux'). */
  platform: string;
  /** Partial: a hand-edited or older file may carry only some of these fields; absent fields are left alone by Merge and reset to defaults by Replace. */
  preferences?: Partial<PortablePreferences>;
  repositories?: PortableRepository[];
  integrations?: Partial<PortableIntegrations>;
}

export interface ImportPreviewSection {
  name: SettingsSection;
  adds: number;
  changes: number;
  skipped: number;
}

export interface ImportPreview {
  sections: ImportPreviewSection[];
  /** Paths from the repositories section that do not exist on this machine (informational; they still import as missing entries). */
  missingRepositories: string[];
  warnings: string[];
}

export type SettingsSyncStateName = 'disabled' | 'gist-missing' | 'up-to-date' | 'local-newer' | 'remote-newer' | 'diverged';

export interface SettingsSyncStatus {
  enabled: boolean;
  gistId: string | null;
  lastSyncedAt: string | null;
  remoteUpdatedAt: string | null;
  localHash: string | null;
  remoteHash: string | null;
  state: SettingsSyncStateName;
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
  confirmCloseIssue: true,
  confirmMarkAllNotificationsRead: true,
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
  defaultWorktreeDirectory: '',
  blameIgnoreWhitespace: true,
  staleBranchDays: 90,
  healthLargeFileThresholdBytes: 5 * 1024 * 1024,
  showUnpushedWorkIndicator: false,
  historyVerifySignatures: false,
  notificationsEnabled: true,
  notificationsPollIntervalMinutes: 2,
  notifyMentions: true,
  notifyReviewRequests: true,
  checkForUpdatesAutomatically: true,
  autoDownloadUpdates: true,
  updateChannel: 'stable',
  watchedFolders: [],
  ai: {
    provider: 'anthropic',
    model: 'claude-opus-5',
    effort: 'high',
    hasApiKey: false,
    claudeCliPath: null,
    autoStageAfterResolve: true,
    reviewStrictness: 'strict',
    reviewMaxFiles: 40,
    reviewPostFooter: true,
    explainErrorsAutomatically: false,
    reviewBeforeCommit: false,
    agentCommand: 'claude',
    agentCustomCommand: '',
    agentHandoffNoticeShown: false,
    triageAutoRefresh: false,
    triageIncludeDiffStat: true,
    releaseNotesAudience: 'users',
    postResolveCheck: null,
    postResolveCheckFromRepo: true,
    nlPaletteEnabled: true,
  },
};
