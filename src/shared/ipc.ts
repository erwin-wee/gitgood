import type {
  AddWorktreeOptions,
  AiSettings,
  AppInfo,
  AppSettings,
  Branch,
  BlameHunk,
  BlameResult,
  CheckRun,
  CloneOptions,
  Commit,
  CommitDetails,
  CommitFile,
  CommitOptions,
  ConflictResolutionResult,
  CreateIssueOptions,
  CreatePullRequestOptions,
  ExplainFollowUp,
  ExplainReference,
  ExplainSource,
  ExplainTarget,
  Explanation,
  ErrorExplanation,
  ErrorFix,
  FixActionId,
  FixRisk,
  FileAtCommitResult,
  FileDiff,
  FoundEditor,
  FoundShell,
  GitConfigInfo,
  GitErrorInfo,
  GitHubAccount,
  GitHubRepoDetails,
  GitHubRepoRef,
  GitHubRepoSummary,
  HistoryPage,
  HistoryQuery,
  ImportPreview,
  ImportPreviewSection,
  InboxItem,
  InboxPauseReason,
  InboxState,
  InboxSubjectType,
  Issue,
  IssueComment,
  IssueDetail,
  IssueFilter,
  IssueTemplate,
  LfsFile,
  LfsStatus,
  MenuActionEvent,
  NewRepositoryOptions,
  NlPlan,
  NlProgressEvent,
  NlRisk,
  NlRunResult,
  NlStep,
  NotificationReason,
  PathHistoryEntry,
  PostResolveCheckResult,
  PrDraft,
  PrDraftInput,
  ProgressEvent,
  PublishOptions,
  PullRequest,
  RebaseApplyProgress,
  RebasePlan,
  RebasePlanAction,
  RebasePlanRow,
  RebasePreflight,
  RebaseSquashOptions,
  CreateReleaseOptions,
  ReleaseRange,
  ReleaseCommit,
  ReleasePr,
  ReleaseNotes,
  ReleaseNotesInput,
  ReleaseNotesItem,
  ReleaseNotesSection,
  ReleaseNotesUnreferencedEntry,
  ReleaseRangeQuery,
  ReleaseRangeResult,
  Remote,
  RepositoryChangedEvent,
  RepositoryInfo,
  PortableIntegrations,
  PortablePreferences,
  PortableRepository,
  RepositoryStatus,
  SettingsExport,
  SettingsSection,
  SettingsSyncStateName,
  SettingsSyncStatus,
  SplitApplyProgress,
  SplitHunk,
  SplitPlan,
  SplitPlanCommit,
  SplitPreflight,
  SigningConfig,
  SigningConfigInfo,
  SigningKey,
  Stash,
  Submodule,
  SubmoduleState,
  Tag,
  ToolsState,
  UncommittedChangesStrategy,
  AiResolveProgressEvent,
  AiReviewProgressEvent,
  PostReviewOptions,
  PrTriage,
  ReviewPlan,
  ReviewRun,
  ReviewStartOptions,
  ReviewTarget,
  AiTriageProgressEvent,
  TriageState,
  TriageNextAction,
  WorktreeReviewOptions,
  Worktree,
  BranchDeleteResult,
  Housekeeping,
  LargeBlob,
  RepoWork,
  StaleBranch,
  StaleBranchReason,
  UpdateChannel,
  UpdateState,
} from './types';

export interface DiffOptions {
  hideWhitespace: boolean;
  /** Number of context lines; default 3. */
  context?: number;
}

export interface HistoryOptions {
  ref: string | null;
  skip: number;
  limit: number;
  path: string | null;
  search: string | null;
  /** Follow renames of `path` (only meaningful with a single path); ignored otherwise. */
  follow: boolean;
  /** Structured filters from the search box's `key:value` syntax; combined with `search` (see getHistory). */
  query?: HistoryQuery | null;
  /** Adds signature placeholders to the log format and populates Commit.signature. Slower on large histories; default false. */
  verifySignatures?: boolean;
}

export type OperationOutcome = { status: 'complete' | 'conflicts' | 'up-to-date' | 'nothing' };

/**
 * Every request the renderer can make of the main process. The key is the
 * method name, the value its signature. Implemented in src/main/ipc.ts and
 * proxied to the renderer via the preload script.
 */
export interface ApiMethods {
  'app.info': () => Promise<AppInfo>;
  'app.tools': (refresh: boolean) => Promise<ToolsState>;
  'app.settings.get': () => Promise<AppSettings>;
  'app.settings.set': (patch: Partial<AppSettings>) => Promise<AppSettings>;
  'app.setApiKey': (key: string | null) => Promise<AiSettings>;
  'app.openExternal': (url: string) => Promise<void>;
  'app.showItemInFolder': (path: string) => Promise<void>;
  'app.openPath': (path: string) => Promise<void>;
  'app.chooseDirectory': (opts: { title?: string; defaultPath?: string; buttonLabel?: string }) => Promise<string | null>;
  'app.chooseFile': (opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  'app.chooseSavePath': (opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  'app.editors': () => Promise<FoundEditor[]>;
  'app.shells': () => Promise<FoundShell[]>;
  'app.openInEditor': (repoPath: string, filePath: string | null) => Promise<void>;
  'app.openInShell': (repoPath: string) => Promise<void>;
  'app.clipboard.write': (text: string) => Promise<void>;
  'app.pathExists': (path: string) => Promise<boolean>;
  'app.isRepository': (path: string) => Promise<boolean>;
  'app.joinPath': (...parts: string[]) => Promise<string>;
  'app.log': (level: 'info' | 'warn' | 'error', message: string) => Promise<void>;
  'app.zoom': (direction: 'in' | 'out' | 'reset') => Promise<number>;
  'app.notify': (title: string, body: string) => Promise<void>;
  'app.moveToTrash': (path: string) => Promise<void>;

  'gh.auth.status': () => Promise<GitHubAccount | null>;
  'gh.auth.login': (host: string) => Promise<{ ok: boolean; error: string | null }>;
  'gh.auth.cancelLogin': () => Promise<void>;
  'gh.auth.logout': (host: string) => Promise<void>;
  'gh.auth.setupGit': () => Promise<void>;
  /** Requests additional OAuth scopes through the device-flow sign-in (reuses the Sign-in dialog's code UI); used to grant the `notifications` scope from the Inbox panel. */
  'gh.auth.refreshScopes': (scopes: string[]) => Promise<{ ok: boolean; error: string | null }>;
  'gh.repos.list': () => Promise<GitHubRepoSummary[]>;
  'gh.orgs.list': () => Promise<string[]>;
  'gh.repo.view': (repoPath: string) => Promise<GitHubRepoDetails | null>;
  'gh.repo.publish': (repoPath: string, opts: PublishOptions) => Promise<GitHubRepoRef>;
  'gh.repo.fork': (repoPath: string) => Promise<GitHubRepoRef>;
  'gh.pr.list': (repoPath: string, state: 'open' | 'closed' | 'merged' | 'all') => Promise<PullRequest[]>;
  'gh.pr.forBranch': (repoPath: string, branch: string) => Promise<PullRequest | null>;
  'gh.pr.view': (repoPath: string, number: number) => Promise<PullRequest>;
  'gh.pr.checks': (repoPath: string, number: number) => Promise<CheckRun[]>;
  'gh.pr.checkout': (repoPath: string, number: number) => Promise<void>;
  'gh.pr.create': (repoPath: string, opts: CreatePullRequestOptions) => Promise<{ url: string | null }>;
  'gh.pr.merge': (repoPath: string, number: number, method: 'merge' | 'squash' | 'rebase', deleteBranch: boolean) => Promise<void>;
  'gh.pr.ready': (repoPath: string, number: number, ready: boolean) => Promise<void>;
  'gh.pr.close': (repoPath: string, number: number) => Promise<void>;
  'gh.pr.reopen': (repoPath: string, number: number) => Promise<void>;
  'gh.pr.review': (repoPath: string, number: number, action: 'approve' | 'comment' | 'request-changes', body: string) => Promise<void>;
  'gh.pr.comment': (repoPath: string, number: number, body: string) => Promise<void>;
  'gh.pr.template': (repoPath: string) => Promise<string | null>;
  'gh.pr.diff': (repoPath: string, number: number) => Promise<{ files: CommitFile[]; headSha: string; baseSha: string }>;
  'gh.pr.fileDiff': (repoPath: string, number: number, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'gh.gitignoreTemplates': () => Promise<string[]>;
  'gh.licenses': () => Promise<{ key: string; name: string }[]>;
  'gh.avatar': (email: string) => Promise<string | null>;
  'gh.issue.createUrl': (repoPath: string) => Promise<string | null>;
  /** `owner` overrides the target repository as a "login/name" string (used to target a fork's parent); null targets the repository at `repoPath` itself. */
  /** `beforeUpdatedAt` (an ISO timestamp) fetches issues updated strictly before it, for "Load more" beyond gh's 100-item cap. */
  'gh.issue.list': (repoPath: string, filter: IssueFilter, owner: string | null, beforeUpdatedAt?: string | null) => Promise<Issue[]>;
  'gh.issue.view': (repoPath: string, number: number, owner: string | null) => Promise<IssueDetail>;
  'gh.issue.create': (repoPath: string, opts: CreateIssueOptions, owner: string | null) => Promise<{ number: number; url: string }>;
  'gh.issue.setState': (repoPath: string, number: number, state: 'open' | 'closed', owner: string | null) => Promise<void>;
  'gh.issue.comment': (repoPath: string, number: number, body: string, owner: string | null) => Promise<void>;
  'gh.labels': (repoPath: string, owner: string | null) => Promise<{ name: string; color: string; description: string | null }[]>;
  'gh.milestones': (repoPath: string, owner: string | null) => Promise<{ number: number; title: string }[]>;
  'gh.issue.templates': (repoPath: string) => Promise<IssueTemplate[]>;
  'app.issueFilters.get': (repoId: string) => Promise<IssueFilter | null>;
  'app.issueFilters.set': (repoId: string, filter: IssueFilter) => Promise<void>;

  'gh.inbox.get': () => Promise<InboxState>;
  'gh.inbox.refresh': () => Promise<InboxState>;
  'gh.inbox.markRead': (threadIds: string[]) => Promise<void>;
  'gh.inbox.markAllRead': () => Promise<void>;
  'gh.inbox.unsubscribe': (threadId: string) => Promise<void>;
  'app.inbox.clearCache': () => Promise<void>;

  'repos.list': () => Promise<RepositoryInfo[]>;
  'repos.add': (path: string) => Promise<RepositoryInfo>;
  'repos.remove': (id: string, moveToTrash: boolean) => Promise<void>;
  'repos.create': (opts: NewRepositoryOptions) => Promise<RepositoryInfo>;
  'repos.clone': (opts: CloneOptions) => Promise<RepositoryInfo>;
  'repos.setAlias': (id: string, alias: string | null) => Promise<void>;
  'repos.refreshIndicators': () => Promise<RepositoryInfo[]>;

  'repo.open': (path: string) => Promise<RepositoryInfo>;
  'repo.close': (path: string) => Promise<void>;
  'repo.status': (repoPath: string) => Promise<RepositoryStatus>;
  'repo.branches': (repoPath: string) => Promise<Branch[]>;
  'repo.defaultBranch': (repoPath: string) => Promise<string | null>;
  'repo.tags': (repoPath: string) => Promise<Tag[]>;
  'repo.remotes': (repoPath: string) => Promise<Remote[]>;
  'repo.stashes': (repoPath: string) => Promise<Stash[]>;
  'repo.history': (repoPath: string, opts: HistoryOptions) => Promise<HistoryPage>;
  /** Paths (relative to the repo root) whose diff at `sha` matches the query's content/regex filter. */
  'repo.history.matchingFiles': (repoPath: string, sha: string, query: HistoryQuery) => Promise<string[]>;
  'repo.commit.details': (repoPath: string, sha: string) => Promise<CommitDetails>;
  'repo.commit.diff': (repoPath: string, sha: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.diff.working': (repoPath: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.diff.stash': (repoPath: string, stashRef: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.diff.range': (repoPath: string, base: string, head: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.stash.files': (repoPath: string, stashRef: string) => Promise<CommitFile[]>;
  'repo.stash.resolveRef': (repoPath: string, sha: string) => Promise<string | null>;
  'repo.compare': (repoPath: string, base: string, head: string) => Promise<{ ahead: Commit[]; behind: Commit[] }>;
  'repo.readFile': (repoPath: string, path: string) => Promise<string>;
  'repo.writeFile': (repoPath: string, path: string, content: string) => Promise<void>;
  'repo.gitignore.read': (repoPath: string) => Promise<string>;
  'repo.gitignore.write': (repoPath: string, content: string) => Promise<void>;
  'repo.gitignore.add': (repoPath: string, patterns: string[]) => Promise<void>;
  'repo.config': (repoPath: string) => Promise<GitConfigInfo>;
  'repo.config.setIdentity': (repoPath: string | null, scope: 'global' | 'local', name: string, email: string) => Promise<void>;
  'repo.config.unsetLocalIdentity': (repoPath: string) => Promise<void>;
  'repo.signing.get': (repoPath: string) => Promise<SigningConfigInfo>;
  'repo.signing.set': (repoPath: string | null, scope: 'global' | 'local', patch: Partial<SigningConfig>) => Promise<void>;
  'app.signing.keys': (format: 'openpgp' | 'ssh', email: string | null) => Promise<SigningKey[]>;
  'app.signing.test': (repoPath: string) => Promise<{ ok: boolean; message: string; needsPassphrase: boolean }>;
  'repo.remote.set': (repoPath: string, name: string, url: string) => Promise<void>;
  'repo.remote.add': (repoPath: string, name: string, url: string) => Promise<void>;
  'repo.remote.remove': (repoPath: string, name: string) => Promise<void>;
  'repo.worktrees': (repoPath: string) => Promise<Worktree[]>;
  'repo.blame': (repoPath: string, path: string, rev: string | null, ignoreWhitespace: boolean) => Promise<BlameResult>;
  'repo.fileAtCommit': (repoPath: string, sha: string, path: string) => Promise<FileAtCommitResult>;
  'repo.pathHistory': (repoPath: string, path: string) => Promise<PathHistoryEntry[]>;
  'repo.submodules': (repoPath: string) => Promise<Submodule[]>;
  'repo.submodule.open': (repoPath: string, submodulePath: string) => Promise<RepositoryInfo>;
  'repo.lfs.status': (repoPath: string) => Promise<LfsStatus>;
  'repo.lfs.files': (repoPath: string) => Promise<LfsFile[]>;
  'repo.health.largeFiles': (repoPath: string, limit: number) => Promise<LargeBlob[]>;
  'repo.health.staleBranches': (repoPath: string, inactiveDays: number) => Promise<StaleBranch[]>;
  'repo.health.housekeeping': (repoPath: string) => Promise<Housekeeping>;
  'repos.work': () => Promise<RepoWork[]>;
  /** Reads (never runs) the repository's `.gitgood/config.json` post-resolution check command, for the trust-confirmation flow; `command` is null when absent or invalid. `trustState` is 'unknown' only the first time (before the user has ever been asked); 'declined' is sticky until `repo.trustConfig` re-trusts it. */
  'repo.checkConfig': (repoPath: string) => Promise<{ command: string | null; trustState: 'trusted' | 'declined' | 'unknown' }>;
  /** Records whether the user trusts this repository's `.gitgood/config.json` check command; `false` disables it until re-trusted. */
  'repo.trustConfig': (repoPath: string, trusted: boolean) => Promise<void>;

  'git.commit': (repoPath: string, opts: CommitOptions) => Promise<string>;
  'git.undoCommit': (repoPath: string) => Promise<void>;
  'git.discard': (repoPath: string, paths: string[], moveToTrash: boolean) => Promise<void>;
  'git.discardAll': (repoPath: string, moveToTrash: boolean) => Promise<void>;
  'git.discardPatch': (repoPath: string, patch: string) => Promise<void>;
  'git.fetch': (repoPath: string, remote: string | null) => Promise<void>;
  'git.pull': (repoPath: string) => Promise<OperationOutcome>;
  'git.push': (repoPath: string, opts: { force: boolean; setUpstream: boolean; remote: string | null; branch: string | null; tags: boolean }) => Promise<void>;
  'git.checkout': (repoPath: string, ref: string, strategy: UncommittedChangesStrategy) => Promise<void>;
  'git.checkoutRemoteBranch': (repoPath: string, remoteBranch: string, strategy: UncommittedChangesStrategy) => Promise<string>;
  'git.checkoutCommit': (repoPath: string, sha: string) => Promise<void>;
  'git.branch.create': (repoPath: string, name: string, startPoint: string | null, checkout: boolean, strategy: UncommittedChangesStrategy) => Promise<void>;
  'git.branch.rename': (repoPath: string, oldName: string, newName: string) => Promise<void>;
  'git.branch.delete': (repoPath: string, name: string, deleteRemote: boolean) => Promise<void>;
  'git.branch.deleteRemote': (repoPath: string, remote: string, name: string) => Promise<void>;
  'git.merge': (repoPath: string, branch: string, squash: boolean) => Promise<OperationOutcome>;
  'git.merge.abort': (repoPath: string) => Promise<void>;
  'git.merge.continue': (repoPath: string) => Promise<OperationOutcome>;
  'git.rebase': (repoPath: string, onto: string) => Promise<OperationOutcome>;
  /** `unsigned` retries the paused step with `-c commit.gpgsign=false`, for the "Commit unsigned this time" recovery from a signing-failed dialog. Never persists a config change. */
  'git.rebase.continue': (repoPath: string, unsigned?: boolean) => Promise<OperationOutcome>;
  'git.rebase.skip': (repoPath: string) => Promise<OperationOutcome>;
  'git.rebase.abort': (repoPath: string) => Promise<void>;
  'git.cherryPick': (repoPath: string, shas: string[]) => Promise<OperationOutcome>;
  'git.cherryPick.continue': (repoPath: string) => Promise<OperationOutcome>;
  'git.cherryPick.abort': (repoPath: string) => Promise<void>;
  'git.revert': (repoPath: string, sha: string) => Promise<OperationOutcome>;
  'git.revert.continue': (repoPath: string) => Promise<OperationOutcome>;
  'git.revert.abort': (repoPath: string) => Promise<void>;
  'git.squash': (repoPath: string, opts: RebaseSquashOptions) => Promise<OperationOutcome>;
  'git.reorder': (repoPath: string, shas: string[], beforeSha: string | null) => Promise<OperationOutcome>;
  'git.reword': (repoPath: string, sha: string, message: string) => Promise<OperationOutcome>;
  'git.dropCommit': (repoPath: string, sha: string) => Promise<OperationOutcome>;
  'git.stash.push': (repoPath: string, message: string | null, includeUntracked: boolean, paths: string[] | null) => Promise<void>;
  'git.stash.pop': (repoPath: string, ref: string) => Promise<OperationOutcome>;
  'git.stash.apply': (repoPath: string, ref: string) => Promise<OperationOutcome>;
  'git.stash.drop': (repoPath: string, ref: string) => Promise<void>;
  'git.stash.branch': (repoPath: string, sha: string, branchName: string) => Promise<OperationOutcome>;
  'git.tag.create': (repoPath: string, name: string, sha: string, message: string | null) => Promise<void>;
  'git.tag.delete': (repoPath: string, name: string, remote: boolean) => Promise<void>;
  'git.tag.push': (repoPath: string, name: string) => Promise<void>;
  /** `originals`, keyed by path, is the pre-resolution conflicted content the renderer holds for any of `paths` it edited manually (present only for a manual resolution, never an AI one); used to capture "Resolve remaining like…" worked examples. Paths omitted or mapped to null are just marked resolved as before. */
  'git.conflict.markResolved': (repoPath: string, paths: string[], originals?: Record<string, string | null>) => Promise<void>;
  'git.conflict.useSide': (repoPath: string, path: string, side: 'ours' | 'theirs') => Promise<void>;
  'git.conflict.unresolve': (repoPath: string, path: string, originalContent: string | null) => Promise<void>;
  'git.updateFromDefaultBranch': (repoPath: string) => Promise<OperationOutcome>;
  'git.stage': (repoPath: string, paths: string[]) => Promise<void>;
  'git.unstage': (repoPath: string, paths: string[]) => Promise<void>;
  'git.isAncestor': (repoPath: string, ancestor: string, descendant: string) => Promise<boolean>;
  'git.worktree.add': (repoPath: string, opts: AddWorktreeOptions) => Promise<RepositoryInfo>;
  'git.worktree.remove': (repoPath: string, worktreePath: string, force: boolean) => Promise<void>;
  'git.worktree.lock': (repoPath: string, worktreePath: string, locked: boolean, reason: string | null) => Promise<void>;
  'git.worktree.prune': (repoPath: string) => Promise<void>;
  'git.submodule.update': (repoPath: string, paths: string[] | null, init: boolean) => Promise<void>;
  'git.submodule.sync': (repoPath: string) => Promise<void>;
  'git.lfs.install': (repoPath: string) => Promise<void>;
  'git.lfs.track': (repoPath: string, pattern: string, track: boolean) => Promise<void>;
  'git.lfs.fetch': (repoPath: string, mode: 'fetch-all' | 'pull', paths: string[] | null) => Promise<void>;
  'git.lfs.prune': (repoPath: string, dryRun: boolean) => Promise<{ objects: number; bytes: number }>;
  'git.branch.deleteMany': (repoPath: string, names: string[], deleteRemote: boolean) => Promise<BranchDeleteResult>;
  'git.remote.prune': (repoPath: string, remote: string) => Promise<void>;
  'git.gc': (repoPath: string, aggressive: boolean) => Promise<void>;
  'git.reflog.expire': (repoPath: string) => Promise<void>;
  'app.operations.cancel': (id: string) => Promise<void>;

  /** `checkOutput`, when given, is the single allowed "Ask AI to fix" retry after a failed post-resolution check; `original` is the failed run's true pre-resolution conflicted content, since the file on disk no longer has markers at retry time. */
  'ai.resolve': (repoPath: string, path: string, checkOutput?: { command: string; tail: string; original: string }) => Promise<ConflictResolutionResult>;
  'ai.resolveAll': (repoPath: string) => Promise<ConflictResolutionResult[]>;
  /** Resolves every remaining conflicted file guided by the manual resolutions recorded so far in this operation (see `ai.resolve.examples`); each result's `guidedBy` names the example paths used. */
  'ai.resolveAllGuided': (repoPath: string) => Promise<ConflictResolutionResult[]>;
  /** Rewrites one resolved block from `original` to `side`, keeping the AI text for the other blocks (whose current locations are given by `ranges`, from the last resolve/guided result); refused if the file on disk no longer matches those ranges. */
  'ai.resolve.useSideForBlock': (repoPath: string, path: string, original: string, ranges: { id: number; start: number; end: number }[], blockId: number, side: 'ours' | 'theirs' | 'base') => Promise<{ content: string; ranges: { id: number; start: number; end: number }[] }>;
  /** Runs an arbitrary check command in the repository root, for the Options → AI "Test command" button. Never gated by trust (the user is typing it directly). */
  'ai.resolve.runCheck': (repoPath: string, command: string) => Promise<PostResolveCheckResult>;
  /** Paths of manual resolutions recorded for the repository's current operation, offered as "Resolve remaining like …"; empty once the operation ends. */
  'ai.resolve.examples': (repoPath: string) => Promise<string[]>;
  'ai.resolve.clearExamples': (repoPath: string) => Promise<void>;
  'ai.cancel': () => Promise<void>;
  'ai.test': () => Promise<{ ok: boolean; message: string }>;
  'ai.commitMessage': (repoPath: string, files: string[]) => Promise<{ summary: string; description: string }>;
  'ai.review.plan': (repoPath: string, target: ReviewTarget) => Promise<ReviewPlan>;
  'ai.review.start': (repoPath: string, target: ReviewTarget, opts?: ReviewStartOptions) => Promise<ReviewRun>;
  'ai.review.get': (repoPath: string, target: ReviewTarget) => Promise<ReviewRun | null>;
  'ai.review.dismiss': (repoPath: string, runId: string, findingId: string, dismissed: boolean) => Promise<void>;
  'ai.review.post': (repoPath: string, opts: PostReviewOptions) => Promise<{ url: string }>;
  /** Reviews the exact patch the pending commit would apply (see WorktreeReviewOptions); persists one run per repository, replacing the previous one. */
  'ai.review.startWorktree': (repoPath: string, opts: WorktreeReviewOptions) => Promise<ReviewRun>;
  /** Paths in the run whose file content hash no longer matches the hash recorded when it was reviewed (edited or deleted since). */
  'ai.review.worktreeStale': (repoPath: string, runId: string) => Promise<string[]>;
  /** Writes a finding's suggestion into the working tree, replacing [line, endLine]. Refuses when the file's content hash has changed since the review or the finding's file was partially selected. */
  'ai.review.applySuggestion': (repoPath: string, runId: string, findingId: string) => Promise<void>;
  /** Most recently finished review run for the repository, any target (pre-commit, pull request or branch); null when none. */
  'ai.review.latest': (repoPath: string) => Promise<ReviewRun | null>;
  /** Rewrites the agent export (`<git-dir>/gitgood/review/latest.*`) for the run and returns the absolute path of latest.md. */
  'ai.review.exportPath': (repoPath: string, runId: string) => Promise<string>;
  /** Writes the export, then opens the repository in the configured terminal running the configured agent command. `launched` is false when the terminal could not run a command and the command was copied to the clipboard instead. */
  'ai.review.fixWithAgent': (repoPath: string, runId: string) => Promise<{ launched: boolean; command: string }>;
  'ai.explain': (repoPath: string, target: ExplainTarget) => Promise<Explanation>;
  'ai.explain.followUp': (repoPath: string, target: ExplainTarget, history: ExplainFollowUp[], question: string) => Promise<string>;
  'ai.explainError': (repoPath: string | null, error: GitErrorInfo, retryable: boolean) => Promise<ErrorExplanation>;
  /** Drafts a pull request title and body from the commits and diff ahead of `input.base`. Progress is reported via `ai.progress` with path `<pull request>`; `ai.cancel` aborts. */
  'ai.prDraft': (repoPath: string, input: PrDraftInput) => Promise<PrDraft>;
  /** Gathers the non-merge commits and referenced pull requests for a release notes range, plus the latest reachable tag (for the dialog's defaults). */
  'repo.release.range': (repoPath: string, query: ReleaseRangeQuery) => Promise<ReleaseRangeResult>;
  /** Drafts categorized, reference-checked release notes for a range. Progress is reported via `ai.progress` with path `<release notes>`; `ai.cancel` aborts. */
  'ai.releaseNotes': (repoPath: string, input: ReleaseNotesInput) => Promise<ReleaseNotes>;
  /** Prepends `markdown` under CHANGELOG.md's top heading (or creates the file) at the repository root, preserving its line endings. */
  'repo.changelog.insert': (repoPath: string, markdown: string) => Promise<{ created: boolean }>;
  'gh.release.create': (repoPath: string, opts: CreateReleaseOptions) => Promise<{ url: string }>;
  /** Null when no release exists yet for `tag`. */
  'gh.release.view': (repoPath: string, tag: string) => Promise<{ url: string } | null>;
  /** Removes a stale `.git/index.lock`; refuses (returning `removed: false` with a reason) when a git process is running or the lock is younger than 10 seconds. */
  'git.removeLockFile': (repoPath: string) => Promise<{ removed: boolean; reason: string | null }>;

  /** Cached triage lines for a repository's pull requests, keyed by number; entries older than 30 days are already dropped. Never calls gh. */
  /** Fast, non-AI summary of what a split would include (files, hunks, excluded/whole-file-only items, size estimate); shown before the model is ever called. */
  'ai.split.preflight': (repoPath: string, files: string[]) => Promise<SplitPreflight>;
  /** Calls the model to group `files`' pending hunks/whole-file changes into an ordered, editable set of commits. Nothing is staged or committed. `fileOnly` forces headers/stats only (no hunk bodies) regardless of size, for the pre-flight's explicit "split by file only" choice; it is always forced automatically above the 150,000-byte budget either way. */
  'ai.split.plan': (repoPath: string, files: string[], fileOnly?: boolean) => Promise<SplitPlan>;
  /** Creates the plan's commits in order via the same partial-patch path as a manual commit. Refuses (code 'split-stale') if any included file's content hash no longer matches the plan. Progress via `ai.split.progress`; stops on the first failure, leaving earlier commits intact and nothing staged. */
  'ai.split.apply': (repoPath: string, plan: SplitPlan) => Promise<{ shas: string[] }>;
  /** `git reset --soft startSha` then unstages everything, restoring the pre-split HEAD while keeping every change in the working tree. */
  'ai.split.undo': (repoPath: string, startSha: string) => Promise<void>;

  /** Fast, non-AI summary of the commit range ("Tidy up branch with AI"): resolved base, commit count, how many are already pushed, and whether a merge commit is in range. `shas`, when given (a History multi-selection), resolves the base as the parent of the oldest selected commit instead of using `base`. */
  'ai.rebase.preflight': (repoPath: string, base: string, shas: string[] | null) => Promise<RebasePreflight>;
  /** Calls the model to propose a squash/reword/reorder/drop cleanup of the commits ahead of the base. Nothing is rewritten. Refuses when the current branch is the default branch, the working tree is dirty, or the range includes a merge commit. */
  'ai.rebase.plan': (repoPath: string, base: string, shas: string[] | null) => Promise<RebasePlan>;
  /** Applies the (possibly user-edited) plan by driving the existing squash/reword/reorder/drop operations in the computed order (drops, rewords, reorders, squashes). Progress via `ai.rebase.progress`. A conflict returns `{status:'conflicts'}` and surfaces the standard conflicts banner; its Continue/Abort transparently resume or fully unwind the plan via the existing `git.rebase.continue`/`git.rebase.abort` methods. */
  'ai.rebase.apply': (repoPath: string, plan: RebasePlan) => Promise<OperationOutcome>;
  /** Resets the branch to `startSha` (the plan's recorded HEAD before Apply); refused unless the working tree is clean and `startSha` is still an ancestor of HEAD. */
  'ai.rebase.undo': (repoPath: string, startSha: string) => Promise<void>;

  'ai.triage.get': (repoPath: string) => Promise<Record<number, PrTriage>>;
  /** Requests fresh triage lines for `numbers` (open pull requests lacking a fresh cache entry), batched, cancellable via `ai.cancel`. Returns the full updated cache. */
  'ai.triage.run': (repoPath: string, numbers: number[]) => Promise<Record<number, PrTriage>>;
  'ai.triage.clear': (repoPath: string) => Promise<void>;

  // ---------------- ai command palette (natural language to git plan) ----------------
  /** Sends `request` (plus, on the answer round, `priorQuestion`/`answer`) to the model and runs the response through the allowlist/denylist policy; never runs anything. */
  'ai.nl.plan': (repoPath: string, request: string, priorQuestion: string | null, answer: string | null) => Promise<NlPlan>;
  /** Recomputes one step's preview (the fixed table in design.md) against the live repository; also re-verifies the step's refs and may flip `executable` to false if they no longer resolve. */
  'ai.nl.preview': (repoPath: string, step: NlStep) => Promise<NlStep>;
  /** Executes exactly the steps in `confirmedStepIds` (a subset of `plan.steps`, in the plan's order), stopping at the first failure. Steps outside the allowlist are refused even if listed. Only one `ai.nl.plan`/`ai.nl.run` may be in flight per repository at a time. */
  'ai.nl.run': (repoPath: string, plan: NlPlan, confirmedStepIds: string[]) => Promise<NlRunResult>;

  // ---------------- auto-update ----------------
  'app.update.state': () => Promise<UpdateState>;
  /** Always runs, regardless of the automatic-check setting (manual checks always work). */
  'app.update.check': () => Promise<UpdateState>;
  /** Fallback provider: opens the release page in the browser for the currently available version. A future downloader-backed provider would instead start a background download here. */
  'app.update.download': () => Promise<void>;
  /** Refused (throws) while a merge/rebase/cherry-pick/revert is in progress or an AI task is running; see canInstall in src/main/update/update-core.ts. The fallback provider has nothing to install and always refuses with an explanatory message even when the gate passes. */
  'app.update.install': () => Promise<void>;
  'app.update.dismiss': (version: string) => Promise<void>;

  // ---------------- settings export / import / gist sync ----------------
  'settings.export': (sections: SettingsSection[]) => Promise<SettingsExport>;
  'settings.exportToFile': (path: string, sections: SettingsSection[]) => Promise<void>;
  'settings.previewImport': (path: string, mode: 'merge' | 'replace') => Promise<ImportPreview>;
  'settings.import': (path: string, mode: 'merge' | 'replace', sections: SettingsSection[]) => Promise<AppSettings>;
  'settings.sync.status': () => Promise<SettingsSyncStatus>;
  'settings.sync.enable': () => Promise<{ gistId: string }>;
  'settings.sync.disable': (deleteGist: boolean) => Promise<void>;
  'settings.sync.upload': () => Promise<void>;
  'settings.sync.download': (mode: 'merge' | 'replace') => Promise<AppSettings>;
}

export type ApiMethodName = keyof ApiMethods;

export interface EventPayloads {
  progress: ProgressEvent;
  'repo.changed': RepositoryChangedEvent;
  'repos.changed': RepositoryInfo[];
  'menu.action': MenuActionEvent;
  'gh.auth.code': { code: string; url: string };
  'gh.auth.finished': { ok: boolean; error: string | null };
  'ai.progress': AiResolveProgressEvent;
  'ai.review.progress': AiReviewProgressEvent;
  'ai.triage.progress': AiTriageProgressEvent;
  'ai.split.progress': SplitApplyProgress;
  'ai.rebase.progress': RebaseApplyProgress;
  'ai.nl.progress': NlProgressEvent;
  'settings.changed': AppSettings;
  'theme.changed': { dark: boolean };
  'tools.changed': ToolsState;
  'window.focus': { focused: boolean };
  'gh.inbox.changed': InboxState;
  'app.update.changed': UpdateState;
}

export type EventName = keyof EventPayloads;

export const IPC_INVOKE_CHANNEL = 'gitgood:invoke';
export const IPC_EVENT_CHANNEL = 'gitgood:event';

export interface GitGoodApi {
  invoke<K extends ApiMethodName>(method: K, ...args: Parameters<ApiMethods[K]>): ReturnType<ApiMethods[K]>;
  on<K extends EventName>(event: K, listener: (payload: EventPayloads[K]) => void): () => void;
  platform: string;
}

// Re-exported so the renderer can import everything from one place.
export type { Remote, CommitFile, Stash, Tag, Branch, Commit, HistoryPage, HistoryQuery, FileDiff, ConflictResolutionResult, CommitDetails, RepositoryStatus, RepositoryInfo, MenuActionEvent, RepositoryChangedEvent, ProgressEvent, FoundEditor, FoundShell, GitConfigInfo, GitHubRepoDetails, GitHubRepoRef, GitHubRepoSummary, PullRequest, CheckRun, GitHubAccount, ToolsState, AppInfo, AppSettings, AiSettings, CloneOptions, CommitOptions, CreatePullRequestOptions, NewRepositoryOptions, PublishOptions, RebaseSquashOptions, UncommittedChangesStrategy, AiResolveProgressEvent, AiReviewProgressEvent, PostReviewOptions, ReviewPlan, ReviewRun, ReviewStartOptions, ReviewTarget, WorktreeReviewOptions, Worktree, AddWorktreeOptions, PrTriage, TriageState, TriageNextAction, AiTriageProgressEvent, BlameResult, BlameHunk, FileAtCommitResult, PathHistoryEntry, Submodule, SubmoduleState, LfsStatus, LfsFile, LargeBlob, StaleBranch, StaleBranchReason, RepoWork, Housekeeping, BranchDeleteResult, SigningConfig, SigningConfigInfo, SigningKey, InboxItem, InboxState, InboxPauseReason, InboxSubjectType, NotificationReason, SettingsSection, SettingsExport, ImportPreview, ImportPreviewSection, PortablePreferences, PortableIntegrations, PortableRepository, SettingsSyncStatus, SettingsSyncStateName, UpdateState, UpdateChannel, ExplainSource, ExplainTarget, Explanation, ExplainReference, ExplainFollowUp, ErrorExplanation, ErrorFix, FixActionId, FixRisk, PrDraft, PrDraftInput, ReleaseRange, ReleaseCommit, ReleasePr, ReleaseRangeQuery, ReleaseRangeResult, ReleaseNotesInput, ReleaseNotesItem, ReleaseNotesSection, ReleaseNotesUnreferencedEntry, ReleaseNotes, CreateReleaseOptions, SplitHunk, SplitPlanCommit, SplitPlan, SplitPreflight, SplitApplyProgress, RebasePlanAction, RebasePlanRow, RebasePlan, RebasePreflight, RebaseApplyProgress, NlRisk, NlStep, NlPlan, NlRunResult, NlProgressEvent };
