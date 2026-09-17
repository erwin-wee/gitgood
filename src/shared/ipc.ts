import type {
  AiSettings,
  AppInfo,
  AppSettings,
  Branch,
  CheckRun,
  CloneOptions,
  Commit,
  CommitDetails,
  CommitFile,
  CommitOptions,
  ConflictResolutionResult,
  CreatePullRequestOptions,
  FileDiff,
  FoundEditor,
  FoundShell,
  GitConfigInfo,
  GitHubAccount,
  GitHubRepoDetails,
  GitHubRepoRef,
  GitHubRepoSummary,
  HistoryPage,
  MenuActionEvent,
  NewRepositoryOptions,
  ProgressEvent,
  PublishOptions,
  PullRequest,
  RebaseSquashOptions,
  Remote,
  RepositoryChangedEvent,
  RepositoryInfo,
  RepositoryStatus,
  Stash,
  Tag,
  ToolsState,
  UncommittedChangesStrategy,
  AiResolveProgressEvent,
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
  'gh.gitignoreTemplates': () => Promise<string[]>;
  'gh.licenses': () => Promise<{ key: string; name: string }[]>;
  'gh.avatar': (email: string) => Promise<string | null>;
  'gh.issue.createUrl': (repoPath: string) => Promise<string | null>;

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
  'repo.commit.details': (repoPath: string, sha: string) => Promise<CommitDetails>;
  'repo.commit.diff': (repoPath: string, sha: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.diff.working': (repoPath: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.diff.stash': (repoPath: string, stashRef: string, path: string, opts: DiffOptions) => Promise<FileDiff>;
  'repo.stash.files': (repoPath: string, stashRef: string) => Promise<CommitFile[]>;
  'repo.compare': (repoPath: string, base: string, head: string) => Promise<{ ahead: Commit[]; behind: Commit[] }>;
  'repo.readFile': (repoPath: string, path: string) => Promise<string>;
  'repo.writeFile': (repoPath: string, path: string, content: string) => Promise<void>;
  'repo.gitignore.read': (repoPath: string) => Promise<string>;
  'repo.gitignore.write': (repoPath: string, content: string) => Promise<void>;
  'repo.gitignore.add': (repoPath: string, patterns: string[]) => Promise<void>;
  'repo.config': (repoPath: string) => Promise<GitConfigInfo>;
  'repo.config.setIdentity': (repoPath: string | null, scope: 'global' | 'local', name: string, email: string) => Promise<void>;
  'repo.config.unsetLocalIdentity': (repoPath: string) => Promise<void>;
  'repo.remote.set': (repoPath: string, name: string, url: string) => Promise<void>;
  'repo.remote.add': (repoPath: string, name: string, url: string) => Promise<void>;
  'repo.remote.remove': (repoPath: string, name: string) => Promise<void>;

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
  'git.rebase.continue': (repoPath: string) => Promise<OperationOutcome>;
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
  'git.tag.create': (repoPath: string, name: string, sha: string, message: string | null) => Promise<void>;
  'git.tag.delete': (repoPath: string, name: string, remote: boolean) => Promise<void>;
  'git.tag.push': (repoPath: string, name: string) => Promise<void>;
  'git.conflict.markResolved': (repoPath: string, paths: string[]) => Promise<void>;
  'git.conflict.useSide': (repoPath: string, path: string, side: 'ours' | 'theirs') => Promise<void>;
  'git.conflict.unresolve': (repoPath: string, path: string, originalContent: string | null) => Promise<void>;
  'git.updateFromDefaultBranch': (repoPath: string) => Promise<OperationOutcome>;
  'git.stage': (repoPath: string, paths: string[]) => Promise<void>;
  'git.unstage': (repoPath: string, paths: string[]) => Promise<void>;
  'git.isAncestor': (repoPath: string, ancestor: string, descendant: string) => Promise<boolean>;

  'ai.resolve': (repoPath: string, path: string) => Promise<ConflictResolutionResult>;
  'ai.resolveAll': (repoPath: string) => Promise<ConflictResolutionResult[]>;
  'ai.cancel': () => Promise<void>;
  'ai.test': () => Promise<{ ok: boolean; message: string }>;
  'ai.commitMessage': (repoPath: string, files: string[]) => Promise<{ summary: string; description: string }>;
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
  'settings.changed': AppSettings;
  'theme.changed': { dark: boolean };
  'tools.changed': ToolsState;
  'window.focus': { focused: boolean };
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
export type { Remote, CommitFile, Stash, Tag, Branch, Commit, HistoryPage, FileDiff, ConflictResolutionResult, CommitDetails, RepositoryStatus, RepositoryInfo, MenuActionEvent, RepositoryChangedEvent, ProgressEvent, FoundEditor, FoundShell, GitConfigInfo, GitHubRepoDetails, GitHubRepoRef, GitHubRepoSummary, PullRequest, CheckRun, GitHubAccount, ToolsState, AppInfo, AppSettings, AiSettings, CloneOptions, CommitOptions, CreatePullRequestOptions, NewRepositoryOptions, PublishOptions, RebaseSquashOptions, UncommittedChangesStrategy, AiResolveProgressEvent };
