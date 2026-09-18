import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron';
import type { ApiMethodName, ApiMethods, DiffOptions, EventPayloads, HistoryOptions } from '@shared/ipc';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc';
import type { AppSettings, CommitFile, CommitOptions, GitErrorInfo, GitHubRepoRef, IpcResult, ProgressEvent, RepositoryStatus, WorkingFile } from '@shared/types';
import { AiError } from './ai/backends';
import type { ErrorExplainService } from './ai/error-explain';
import type { ExplainService } from './ai/explain';
import type { NlPaletteService } from './ai/nlPalette';
import type { PrDraftService } from './ai/prDraft';
import type { RebasePlanService } from './ai/rebasePlan';
import { insertIntoChangelog } from './ai/release-notes-core';
import type { ReleaseNotesService } from './ai/release-notes';
import type { ConflictResolver } from './ai/resolver';
import type { ReviewService } from './ai/review';
import type { SplitterService } from './ai/splitter';
import type { TriageService } from './ai/triage';
import type { InboxPoller } from './gh/inbox-poller';
import { discoverIssueTemplates } from './gh/issue-templates';
import type { SettingsSyncService } from './gh/settings-sync';
import { GitError, toGitErrorInfo, type GitClient } from './git/git';
import { getBlameResult, readFileAtCommit } from './git/blame';
import { checkoutBranch, checkoutRemoteBranch, createBranch, deleteLocalBranch, deleteRemoteBranch, getBranches, getCurrentBranchName, getDefaultBranch, renameBranch } from './git/branches';
import { applyPatchToWorktree, createCommit, getLastCommitMessage, isUnborn, stageFiles, undoLastCommit, unstageFiles } from './git/commit';
import { getCommitFileDiff, getRangeFileDiff, getStashFileDiff, getStashFiles, getWorkingDiff, toFsPath } from './git/diff';
import { deleteManyBranches, expireReflog, findLargestBlobs, getHousekeeping, getStaleBranches, pruneRemote, runGc } from './git/health';
import { getLfsFiles, getLfsStatus, lfsFetch, lfsInstallLocal, lfsPrune, setLfsTracking } from './git/lfs';
import { compareRefs, getCommit, getCommitFiles, getHistory, getMatchingFiles, getPathHistory, isCommitPushed } from './git/log';
import * as ops from './git/operations';
import { gpgKeyExists, listGpgSecretKeys, listSshPublicKeys, normalizeSshSigningKey, sshKeyFileExists, testGpgSigning, testSshSigning } from './git/signing';
import { getStatus } from './git/status';
import { getSubmodules, syncSubmodules, updateSubmodules } from './git/submodules';
import { addWorktree, listWorktrees, lockWorktree, pruneWorktrees, removeWorktree } from './git/worktree';
import { repoSelector, type GhClient } from './gh/gh';
import { findPullRequestTemplate } from './gh/pr-template';
import { findEditors, openInEditor } from './integrations/editors';
import { findShells, openShell } from './integrations/shells';
import { getLogPath, log } from './logger';
import { readRepoConfig } from './repo/config';
import type { RepositoryManager } from './repo/manager';
import type { Store } from './store';
import type { ToolLocator } from './tools';
import { canInstall } from './update/update-core';
import type { Updater } from './update/updater';

export interface AppContext {
  store: Store;
  tools: ToolLocator;
  git: GitClient;
  gh: GhClient;
  repos: RepositoryManager;
  resolver: ConflictResolver;
  review: ReviewService;
  splitter: SplitterService;
  triage: TriageService;
  prDraft: PrDraftService;
  rebasePlan: RebasePlanService;
  releaseNotes: ReleaseNotesService;
  nlPalette: NlPaletteService;
  explain: ExplainService;
  errorExplain: ErrorExplainService;
  inbox: InboxPoller;
  settingsSync: SettingsSyncService;
  updater: Updater;
  getWindow: () => BrowserWindow | null;
  busy: Set<string>;
}

export function sendEvent<K extends keyof EventPayloads>(win: BrowserWindow | null, event: K, payload: EventPayloads[K]): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC_EVENT_CHANNEL, event, payload);
}

function toErrorInfo(err: unknown): GitErrorInfo {
  if (err instanceof AiError) {
    const code = err.kind === 'not-configured' ? 'ai-not-configured' : err.kind === 'cancelled' ? 'cancelled' : err.kind === 'stale' ? 'split-stale' : 'unknown';
    return { message: err.message, command: '', exitCode: null, stderr: '', stdout: '', code };
  }
  return toGitErrorInfo(err);
}

/** Synthetic `ai.progress` path used for the PR draft service, which has no single file of its own. */
const PR_DRAFT_PROGRESS_PATH = '<pull request>';
/** Synthetic `ai.progress` path used for the release notes service, which has no single file of its own. */
const RELEASE_NOTES_PROGRESS_PATH = '<release notes>';

const commitCache = new Map<string, { commit: Awaited<ReturnType<typeof getCommit>>; files: CommitFile[] }>();

/** Per-repository "latest history request wins": a new `repo.history` call aborts whatever git process the previous one started. */
const historyControllers = new Map<string, AbortController>();

/** Long-running operations (submodule update, LFS fetch/pull) keyed by their progress event id, cancellable via `app.operations.cancel`. */
const operationControllers = new Map<string, AbortController>();

export function registerIpc(ctx: AppContext): void {
  const { store, tools, git, gh, repos, resolver, review, splitter, triage, prDraft, rebasePlan, releaseNotes, explain, errorExplain, inbox, settingsSync, updater, nlPalette } = ctx;
  const send: <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void = (event, payload) => sendEvent(ctx.getWindow(), event, payload);
  const statusCache = new Map<string, { status: RepositoryStatus; at: number }>();

  const progress = (kind: ProgressEvent['kind'], title: string, repoPath: string | null) => {
    const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emit = (percent: number | null, description: string, done = false) => send('progress', { id, kind, title, description, percent, done, repoPath });
    emit(null, 'Starting…');
    return {
      id,
      update: (percent: number | null, description: string) => emit(percent, description),
      done: () => emit(1, 'Done', true),
    };
  };

  /** Runs a cancellable long operation, registering its AbortController under the progress event's id so `app.operations.cancel` can stop it. */
  const withCancellableProgress = async <T>(kind: ProgressEvent['kind'], title: string, repoPath: string, fn: (onProgress: (percent: number | null, description: string) => void, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const p = progress(kind, title, repoPath);
    const controller = new AbortController();
    operationControllers.set(p.id, controller);
    try {
      return await withBusy(repoPath, () => fn((pct, d) => p.update(pct, d), controller.signal));
    } finally {
      operationControllers.delete(p.id);
      p.done();
    }
  };

  const withBusy = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    ctx.busy.add(key);
    try {
      return await fn();
    } finally {
      ctx.busy.delete(key);
    }
  };

  const freshStatus = async (repoPath: string): Promise<RepositoryStatus> => {
    const status = await getStatus(git, repoPath);
    statusCache.set(repoPath, { status, at: Date.now() });
    return status;
  };

  const findWorkingFile = async (repoPath: string, path: string): Promise<WorkingFile> => {
    const cached = statusCache.get(repoPath);
    let file = cached && Date.now() - cached.at < 5000 ? cached.status.files.find((f) => f.path === path) : undefined;
    if (!file) file = (await freshStatus(repoPath)).files.find((f) => f.path === path);
    if (!file) {
      // File may have been reverted in the meantime; render whatever is on disk.
      return { path, oldPath: null, status: 'modified', staged: false, unstaged: true, submodule: false, conflict: null, lfs: false };
    }
    return file;
  };

  const requireGitHub = async (repoPath: string): Promise<GitHubRepoRef> => {
    const ref = await repos.detectGitHub(repoPath);
    if (!ref) throw new GitError({ message: 'This repository does not have a GitHub remote.', command: '', exitCode: null, stderr: '', stdout: '', code: 'remote-not-found' });
    return ref;
  };

  /** Selector for `--repo` on issue/label/milestone commands: `owner` (a "login/name" string) overrides the repository at `repoPath`, used to target a fork's parent. */
  const issueSelector = async (repoPath: string, owner: string | null): Promise<string> => {
    const ref = await requireGitHub(repoPath);
    if (!owner) return repoSelector(ref);
    return ref.host === 'github.com' ? owner : `${ref.host}/${owner}`;
  };

  const commitInfo = async (repoPath: string, sha: string) => {
    const withSignature = store.getSettings().historyVerifySignatures;
    const key = `${repoPath}\0${sha}\0${withSignature}`;
    const cached = commitCache.get(key);
    if (cached) return cached;
    const commit = await getCommit(git, repoPath, sha, withSignature);
    const files = await getCommitFiles(git, repoPath, sha, commit.parents);
    const entry = { commit, files };
    if (commitCache.size > 300) commitCache.delete(commitCache.keys().next().value!);
    commitCache.set(key, entry);
    return entry;
  };

  const pullRebaseFlag = async (repoPath: string): Promise<boolean | null> => {
    const behavior = store.getSettings().pullBehavior;
    if (behavior === 'merge') return false;
    if (behavior === 'rebase') return true;
    return ops.getPullRebaseConfig(git, repoPath);
  };

  const stashBeforeCheckout = async (repoPath: string, strategy: AppSettings['uncommittedChangesStrategy']) => {
    if (strategy !== 'stash') return;
    const status = await freshStatus(repoPath);
    if (!status.files.length) return;
    await ops.stashPush(git, repoPath, 'Stashed before switching branches', true, null, status.branch.name);
  };

  const discardPaths = async (repoPath: string, paths: string[], moveToTrash: boolean) => {
    const status = await freshStatus(repoPath);
    const files = status.files.filter((f) => paths.includes(f.path) || (f.oldPath && paths.includes(f.oldPath)));
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const f of files) {
      if (f.status === 'untracked' || (f.status === 'new' && f.staged)) untracked.push(f.path);
      else {
        tracked.push(f.path);
        if (f.oldPath) tracked.push(f.oldPath);
      }
      if (moveToTrash && f.status !== 'deleted') {
        const fs = toFsPath(repoPath, f.path);
        if (existsSync(fs)) {
          try {
            await shell.trashItem(fs);
          } catch (err) {
            log.warn(`Could not move ${fs} to trash: ${(err as Error).message}`);
          }
        }
      }
    }
    const unborn = await isUnborn(git, repoPath);
    if (untracked.length) {
      if (!unborn) await git.tryRun(repoPath, ['reset', '-q', '--', ...untracked]);
      else await git.tryRun(repoPath, ['rm', '-r', '--cached', '-q', '--', ...untracked]);
      await git.run(repoPath, ['clean', '-f', '-d', '-q', '--', ...untracked]);
    }
    if (tracked.length) {
      if (unborn) await git.run(repoPath, ['rm', '-r', '--cached', '-q', '--', ...tracked]);
      else {
        await git.tryRun(repoPath, ['reset', '-q', '--', ...tracked]);
        await git.run(repoPath, ['checkout', 'HEAD', '--', ...tracked]);
      }
    }
  };

  const handlers: ApiMethods = {
    // ---------------- app ----------------
    'app.info': async () => ({ version: app.getVersion(), electron: process.versions.electron ?? '', platform: process.platform, userDataPath: app.getPath('userData'), logPath: getLogPath() }),
    'app.tools': async (refresh) => (refresh ? tools.refresh() : tools.current()),
    'app.settings.get': async () => store.getSettings(),
    'app.settings.set': async (patch) => {
      const before = store.getSettings();
      const next = store.updateSettings(patch);
      if (patch.gitPath !== undefined || patch.ghPath !== undefined || patch.ai?.claudeCliPath !== undefined) {
        void tools.refresh().then((s) => send('tools.changed', s));
      }
      if (patch.theme && patch.theme !== before.theme) {
        const { nativeTheme } = await import('electron');
        nativeTheme.themeSource = patch.theme;
      }
      return next;
    },
    'app.setApiKey': async (key) => {
      store.setApiKey(key && key.trim() ? key.trim() : null);
      return store.getSettings().ai;
    },
    'app.openExternal': async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      await shell.openExternal(url);
    },
    'app.showItemInFolder': async (p) => shell.showItemInFolder(p),
    'app.openPath': async (p) => {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    },
    'app.chooseDirectory': async (opts) => {
      const win = ctx.getWindow();
      const result = await dialog.showOpenDialog(win!, { title: opts.title, defaultPath: opts.defaultPath, buttonLabel: opts.buttonLabel, properties: ['openDirectory', 'createDirectory'] });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    'app.chooseFile': async (opts) => {
      const win = ctx.getWindow();
      const result = await dialog.showOpenDialog(win!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties: ['openFile'] });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    'app.chooseSavePath': async (opts) => {
      const win = ctx.getWindow();
      const result = await dialog.showSaveDialog(win!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    'app.editors': async () => findEditors((await tools.env()).PATH),
    'app.shells': async () => findShells((await tools.env()).PATH),
    'app.openInEditor': async (repoPath, filePath) => {
      const settings = store.getSettings();
      const editors = await findEditors((await tools.env()).PATH);
      const editorPath = settings.externalEditor === 'custom' ? settings.customEditorPath : (editors.find((e) => e.id === settings.externalEditor) ?? editors[0])?.path;
      if (!editorPath) throw new Error('No external editor was found. Configure one in Options → Integrations.');
      const target = filePath ? toFsPath(repoPath, filePath) : repoPath;
      await openInEditor(editorPath, target);
    },
    'app.openInShell': async (repoPath) => {
      const settings = store.getSettings();
      await openShell(settings.shell, settings.shell === 'custom' ? settings.customShellPath : null, repoPath, (await tools.env()).PATH);
    },
    'app.clipboard.write': async (text) => clipboard.writeText(text),
    'app.pathExists': async (p) => existsSync(p),
    'app.isRepository': async (p) => (await ops.getTopLevel(git, p)) !== null,
    'app.joinPath': async (...parts) => join(...parts),
    'app.log': async (level, message) => log[level](`[renderer] ${message}`),
    'app.zoom': async (direction) => {
      const win = ctx.getWindow();
      if (!win) return 0;
      const current = win.webContents.getZoomLevel();
      const next = direction === 'reset' ? 0 : Math.max(-3, Math.min(4, current + (direction === 'in' ? 0.5 : -0.5)));
      win.webContents.setZoomLevel(next);
      store.updateState({ zoomLevel: next });
      return next;
    },
    'app.notify': async (title, body) => {
      if (process.env.GITGOOD_SMOKE_SCRIPT) return; // offscreen smoke runs must not raise desktop notifications
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    'app.moveToTrash': async (p) => shell.trashItem(p),
    'app.operations.cancel': async (id) => {
      operationControllers.get(id)?.abort();
    },

    // ---------------- gh ----------------
    'gh.auth.status': async () => gh.account(),
    'gh.auth.login': async (host) => {
      const result = await gh.login(host, (code, url) => send('gh.auth.code', { code, url }));
      const state = await tools.refresh();
      send('tools.changed', state);
      send('gh.auth.finished', result);
      return result;
    },
    'gh.auth.cancelLogin': async () => gh.cancelLogin(),
    'gh.auth.logout': async (host) => {
      await gh.logout(host);
      send('tools.changed', await tools.refresh());
    },
    'gh.auth.setupGit': async () => {
      await gh.setupGit();
      send('tools.changed', await tools.refresh());
    },
    'gh.auth.refreshScopes': async (scopes) => {
      const host = tools.current().ghAccount?.host ?? 'github.com';
      const result = await gh.refreshScopes(host, scopes, (code, url) => send('gh.auth.code', { code, url }));
      const state = await tools.refresh();
      send('tools.changed', state);
      send('gh.auth.finished', result);
      return result;
    },
    'gh.repos.list': async () => gh.viewerRepositories(),
    'gh.orgs.list': async () => gh.organizations(),
    'gh.repo.view': async (repoPath) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? gh.repoView(ref) : null;
    },
    'gh.repo.publish': async (repoPath, opts) => {
      const unborn = await isUnborn(git, repoPath);
      const ref = await gh.publish(repoPath, opts, !unborn);
      await repos.refreshGitHub(repoPath);
      if (!unborn) {
        const branch = await getCurrentBranchName(git, repoPath);
        if (branch) await git.tryRun(repoPath, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
      }
      return ref;
    },
    'gh.repo.fork': async (repoPath) => {
      const ref = await gh.fork(repoPath);
      await repos.refreshGitHub(repoPath);
      return ref;
    },
    'gh.pr.list': async (repoPath, state) => gh.prList(await requireGitHub(repoPath), state),
    'gh.pr.forBranch': async (repoPath, branch) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? gh.prForBranch(ref, branch) : null;
    },
    'gh.pr.view': async (repoPath, number) => gh.prView(await requireGitHub(repoPath), number),
    'gh.pr.checks': async (repoPath, number) => gh.prChecks(await requireGitHub(repoPath), number),
    'gh.pr.checkout': async (repoPath, number) => withBusy(repoPath, () => gh.prCheckout(repoPath, number)),
    'gh.pr.create': async (repoPath, opts) => gh.prCreate(repoPath, opts),
    'gh.pr.merge': async (repoPath, number, method, deleteBranch) => gh.prMerge(await requireGitHub(repoPath), number, method, deleteBranch),
    'gh.pr.ready': async (repoPath, number, ready) => gh.prReady(await requireGitHub(repoPath), number, ready),
    'gh.pr.close': async (repoPath, number) => gh.prClose(await requireGitHub(repoPath), number),
    'gh.pr.reopen': async (repoPath, number) => gh.prReopen(await requireGitHub(repoPath), number),
    'gh.pr.review': async (repoPath, number, action, body) => gh.prReview(await requireGitHub(repoPath), number, action, body),
    'gh.pr.comment': async (repoPath, number, body) => gh.prComment(await requireGitHub(repoPath), number, body),
    'gh.pr.diff': async (repoPath, number) => review.prFiles(repoPath, number),
    'gh.pr.fileDiff': async (repoPath, number, path, opts) => review.prFileDiff(repoPath, number, path, opts),
    'gh.pr.template': async (repoPath) => findPullRequestTemplate(repoPath),
    'gh.gitignoreTemplates': async () => gh.gitignoreTemplates(),
    'gh.licenses': async () => gh.licenses(),
    'gh.avatar': async (email) => gh.avatarForEmail(email),
    'gh.issue.createUrl': async (repoPath) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? `${ref.url}/issues/new` : null;
    },
    'gh.issue.list': async (repoPath, filter, owner, beforeUpdatedAt) => gh.issueList(await issueSelector(repoPath, owner), filter, beforeUpdatedAt),
    'gh.issue.view': async (repoPath, number, owner) => gh.issueDetail(await issueSelector(repoPath, owner), number),
    'gh.issue.create': async (repoPath, opts, owner) => gh.issueCreate(await issueSelector(repoPath, owner), opts),
    'gh.issue.setState': async (repoPath, number, state, owner) => gh.issueSetState(await issueSelector(repoPath, owner), number, state),
    'gh.issue.comment': async (repoPath, number, body, owner) => gh.issueCommentAdd(await issueSelector(repoPath, owner), number, body),
    'gh.labels': async (repoPath, owner) => gh.labelList(await issueSelector(repoPath, owner)),
    'gh.milestones': async (repoPath, owner) => gh.milestoneList(await issueSelector(repoPath, owner)),
    'gh.issue.templates': async (repoPath) => discoverIssueTemplates(repoPath),
    'app.issueFilters.get': async (repoId) => store.getIssueFilter(repoId),
    'app.issueFilters.set': async (repoId, filter) => store.setIssueFilter(repoId, filter),

    // ---------------- notifications inbox ----------------
    'gh.inbox.get': async () => inbox.getState(),
    'gh.inbox.refresh': async () => inbox.refresh(),
    'gh.inbox.markRead': async (threadIds) => inbox.markRead(threadIds),
    'gh.inbox.markAllRead': async () => inbox.markAllRead(),
    'gh.inbox.unsubscribe': async (threadId) => inbox.unsubscribe(threadId),
    'app.inbox.clearCache': async () => {
      store.clearInboxCache();
      inbox.resetCache();
    },

    // ---------------- repositories ----------------
    'repos.list': async () => repos.list(),
    'repos.add': async (path) => repos.add(path),
    'repos.remove': async (id, moveToTrash) => {
      const repo = await repos.remove(id);
      if (repo && moveToTrash && existsSync(repo.path)) await shell.trashItem(repo.path);
    },
    'repos.create': async (opts) => {
      const dir = resolve(opts.directory, opts.name);
      if (existsSync(dir) && (await readdir(dir)).length && (await ops.getTopLevel(git, dir))) throw new Error(`"${dir}" is already a Git repository.`);
      await mkdir(dir, { recursive: true });
      const configured = (await git.tryRun(null, ['config', '--global', '--get', 'init.defaultBranch']))?.stdout.trim();
      await ops.init(git, dir, configured || 'main');
      const created: string[] = [];
      if (opts.initializeWithReadme) {
        const readme = `# ${opts.name}\n${opts.description ? `\n${opts.description}\n` : ''}`;
        await writeFile(join(dir, 'README.md'), readme, 'utf8');
        created.push('README.md');
      }
      if (opts.gitignoreTemplate) {
        try {
          const source = await gh.gitignoreTemplate(opts.gitignoreTemplate);
          await writeFile(join(dir, '.gitignore'), source, 'utf8');
          created.push('.gitignore');
        } catch (err) {
          log.warn(`Could not fetch .gitignore template: ${(err as Error).message}`);
        }
      }
      if (opts.license) {
        try {
          let body = await gh.licenseText(opts.license);
          const identity = await ops.getConfigIdentity(git, null);
          body = body.replace(/\[year\]/g, String(new Date().getFullYear())).replace(/\[fullname\]/g, identity.global.name ?? '').replace(/\[yyyy\]/g, String(new Date().getFullYear())).replace(/\[name of copyright owner\]/g, identity.global.name ?? '');
          await writeFile(join(dir, 'LICENSE'), body, 'utf8');
          created.push('LICENSE');
        } catch (err) {
          log.warn(`Could not fetch license: ${(err as Error).message}`);
        }
      }
      if (created.length) {
        await stageFiles(git, dir, created);
        await git.run(dir, ['commit', '-q', '-m', 'Initial commit']);
      }
      return repos.add(dir);
    },
    'repos.clone': async (opts) => {
      let url = opts.url.trim();
      if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
      const target = resolve(opts.directory);
      const name = basename(target);
      if (existsSync(target) && (await readdir(target)).length) throw new Error(`The destination "${target}" already exists and is not empty.`);
      await mkdir(resolve(target, '..'), { recursive: true });
      const p = progress('clone', `Cloning ${name}`, null);
      try {
        await withBusy(`clone:${target}`, () => ops.clone(git, url, target, opts.branch, (pct, desc) => p.update(pct, desc)));
      } finally {
        p.done();
      }
      return repos.add(target);
    },
    'repos.setAlias': async (id, alias) => repos.setAlias(id, alias),
    'repos.refreshIndicators': async () => repos.refreshIndicators(),

    // ---------------- repository reads ----------------
    'repo.open': async (path) => repos.open(path),
    'repo.close': async (path) => repos.stopWatching(path),
    'repo.status': async (repoPath) => freshStatus(repoPath),
    'repo.branches': async (repoPath) => getBranches(git, repoPath),
    'repo.defaultBranch': async (repoPath) => getDefaultBranch(git, repoPath),
    'repo.tags': async (repoPath) => ops.getTags(git, repoPath),
    'repo.remotes': async (repoPath) => ops.getRemotes(git, repoPath),
    'repo.stashes': async (repoPath) => ops.getStashes(git, repoPath),
    'repo.history': async (repoPath, opts: HistoryOptions) => {
      historyControllers.get(repoPath)?.abort();
      const controller = new AbortController();
      historyControllers.set(repoPath, controller);
      try {
        return await getHistory(git, repoPath, opts, controller.signal);
      } finally {
        if (historyControllers.get(repoPath) === controller) historyControllers.delete(repoPath);
      }
    },
    'repo.history.matchingFiles': async (repoPath, sha, query) => getMatchingFiles(git, repoPath, sha, query),
    'repo.commit.details': async (repoPath, sha) => {
      const { commit, files } = await commitInfo(repoPath, sha);
      return { commit, files, pushed: await isCommitPushed(git, repoPath, sha) };
    },
    'repo.commit.diff': async (repoPath, sha, path, opts: DiffOptions) => {
      const { commit, files } = await commitInfo(repoPath, sha);
      const file = files.find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: false, lfs: false };
      return getCommitFileDiff(git, repoPath, sha, commit.parents, file, opts);
    },
    'repo.diff.working': async (repoPath, path, opts) => getWorkingDiff(git, repoPath, await findWorkingFile(repoPath, path), opts),
    'repo.diff.stash': async (repoPath, stashRef, path, opts) => getStashFileDiff(git, repoPath, stashRef, path, opts),
    'repo.diff.range': async (repoPath, base, head, path, opts) => {
      const nameStatus = await git.stdout(repoPath, ['diff', '--name-status', '-z', '-M', `${base}...${head}`, '--', path], { readOnly: true, okExitCodes: [1] });
      const { parseNameStatusZ } = await import('./git/log');
      const file = parseNameStatusZ(nameStatus).find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: false, lfs: false };
      return getRangeFileDiff(git, repoPath, base, head, file, opts);
    },
    'repo.stash.files': async (repoPath, stashRef) => getStashFiles(git, repoPath, stashRef),
    'repo.stash.resolveRef': async (repoPath, sha) => ops.resolveStashRef(git, repoPath, sha),
    'repo.compare': async (repoPath, base, head) => compareRefs(git, repoPath, base, head),
    'repo.readFile': async (repoPath, path) => readFile(toFsPath(repoPath, path), 'utf8'),
    'repo.writeFile': async (repoPath, path, content) => {
      const fsPath = toFsPath(repoPath, path);
      await mkdir(dirname(fsPath), { recursive: true });
      await writeFile(fsPath, content, 'utf8');
    },
    'repo.gitignore.read': async (repoPath) => ops.readGitignore(repoPath),
    'repo.gitignore.write': async (repoPath, content) => ops.writeGitignore(repoPath, content),
    'repo.gitignore.add': async (repoPath, patterns) => ops.appendGitignore(repoPath, patterns),
    'repo.config': async (repoPath) => ops.getConfigIdentity(git, repoPath),
    'repo.config.setIdentity': async (repoPath, scope, name, email) => ops.setConfigIdentity(git, repoPath, scope, name, email),
    'repo.config.unsetLocalIdentity': async (repoPath) => ops.unsetLocalIdentity(git, repoPath),
    'repo.signing.get': async (repoPath) => ops.getSigningConfig(git, repoPath || null),
    'repo.signing.set': async (repoPath, scope, patch) => {
      const nextPatch = { ...patch };
      if (nextPatch.key !== undefined && nextPatch.key) {
        const format = nextPatch.format ?? (await ops.getSigningConfig(git, repoPath)).effective.format;
        if (format === 'openpgp') {
          const gpgPath = tools.current().gpg.path;
          if (!gpgPath) throw new GitError({ message: 'GPG was not found, so the key could not be verified. Install GnuPG or set its location.', command: '', exitCode: null, stderr: '', stdout: '', code: 'tool-missing' });
          const ok = await gpgKeyExists(gpgPath, await tools.env(), nextPatch.key);
          if (!ok) throw new GitError({ message: `No secret key "${nextPatch.key}" was found in the GPG keyring.`, command: '', exitCode: null, stderr: '', stdout: '', code: 'signing-key-missing' });
        } else if (format === 'ssh') {
          nextPatch.key = normalizeSshSigningKey(nextPatch.key);
          if (!nextPatch.key.startsWith('key::') && !(await sshKeyFileExists(nextPatch.key))) {
            throw new GitError({ message: `The SSH key file "${nextPatch.key}" was not found.`, command: '', exitCode: null, stderr: '', stdout: '', code: 'signing-key-missing' });
          }
        }
      }
      await ops.setSigningConfig(git, repoPath, scope, nextPatch);
    },
    'app.signing.keys': async (format, email) => {
      const list =
        format === 'openpgp'
          ? await (async () => {
              const gpgPath = tools.current().gpg.path;
              if (!gpgPath) throw new Error('GPG was not found. Install GnuPG or set its location in Options → Advanced.');
              return listGpgSecretKeys(gpgPath, await tools.env());
            })()
          : await listSshPublicKeys(join(homedir(), '.ssh'));
      if (!email) return list;
      const norm = email.trim().toLowerCase();
      return [...list].sort((a, b) => Number(b.email?.toLowerCase() === norm) - Number(a.email?.toLowerCase() === norm));
    },
    'app.signing.test': async (repoPath) => {
      const config = (await ops.getSigningConfig(git, repoPath)).effective;
      if (!config.format || !config.key) return { ok: false, message: 'Configure a signing format and key first.', needsPassphrase: false };
      if (config.format === 'openpgp') {
        const gpgPath = tools.current().gpg.path;
        if (!gpgPath) return { ok: false, message: 'GPG was not found. Install GnuPG or set its location in Options → Advanced.', needsPassphrase: false };
        return testGpgSigning(gpgPath, config.key, await tools.env());
      }
      if (config.format === 'ssh') {
        const sshKeygenPath = tools.current().sshKeygen.path;
        if (!sshKeygenPath) return { ok: false, message: 'ssh-keygen was not found. Install OpenSSH 8.8+ to use SSH commit signing.', needsPassphrase: false };
        if (config.key.startsWith('key::')) return { ok: false, message: 'Test signing needs a key file path; a pasted key can only be tested by making a real commit.', needsPassphrase: false };
        return testSshSigning(sshKeygenPath, config.key, await tools.env());
      }
      return { ok: false, message: `Signing format "${config.format}" is not supported yet.`, needsPassphrase: false };
    },
    'repo.remote.set': async (repoPath, name, url) => {
      await git.run(repoPath, ['remote', 'set-url', name, url]);
      await repos.refreshGitHub(repoPath);
    },
    'repo.remote.add': async (repoPath, name, url) => {
      await git.run(repoPath, ['remote', 'add', name, url]);
      await repos.refreshGitHub(repoPath);
    },
    'repo.remote.remove': async (repoPath, name) => {
      await git.run(repoPath, ['remote', 'remove', name]);
      await repos.refreshGitHub(repoPath);
    },
    'repo.worktrees': async (repoPath) => listWorktrees(git, repoPath),
    'repo.blame': async (repoPath, path, rev, ignoreWhitespace) => getBlameResult(git, repoPath, path, rev, ignoreWhitespace),
    'repo.fileAtCommit': async (repoPath, sha, path) => readFileAtCommit(git, repoPath, sha, path),
    'repo.pathHistory': async (repoPath, path) => getPathHistory(git, repoPath, path),
    'repo.submodules': async (repoPath) => {
      const origin = (await ops.getRemotes(git, repoPath)).find((r) => r.name === 'origin');
      return getSubmodules(git, repoPath, origin?.fetchUrl || origin?.pushUrl || null);
    },
    'repo.submodule.open': async (repoPath, submodulePath) => repos.openSubmodule(repos.getByPath(repoPath)?.id ?? (await repos.add(repoPath)).id, toFsPath(repoPath, submodulePath)),
    'repo.lfs.status': async (repoPath) => getLfsStatus(git, repoPath, tools.current().gitLfs),
    'repo.lfs.files': async (repoPath) => getLfsFiles(git, repoPath),
    'repo.health.largeFiles': async (repoPath, limit) => withCancellableProgress('generic', 'Scanning for large files', repoPath, (_onProgress, signal) => findLargestBlobs(git, tools, repoPath, limit, signal)),
    'repo.health.staleBranches': async (repoPath, inactiveDays) => getStaleBranches(git, repoPath, inactiveDays),
    'repo.health.housekeeping': async (repoPath) => getHousekeeping(git, repoPath),
    'repos.work': async () => repos.work(),

    // ---------------- git writes ----------------
    'git.commit': async (repoPath, opts: CommitOptions) => {
      const status = await freshStatus(repoPath);
      const inProgress = status.operation.kind === 'merge' || status.operation.kind === 'cherry-pick' || status.operation.kind === 'revert';
      return withBusy(repoPath, () => createCommit(git, repoPath, opts, inProgress));
    },
    'git.undoCommit': async (repoPath) => undoLastCommit(git, repoPath),
    'git.discard': async (repoPath, paths, moveToTrash) => discardPaths(repoPath, paths, moveToTrash),
    'git.discardAll': async (repoPath, moveToTrash) => {
      const status = await freshStatus(repoPath);
      await discardPaths(repoPath, status.files.map((f) => f.path), moveToTrash);
    },
    'git.discardPatch': async (repoPath, patch) => applyPatchToWorktree(git, repoPath, patch),
    'git.fetch': async (repoPath, remote) => {
      const p = progress('fetch', 'Fetching', repoPath);
      try {
        await withBusy(repoPath, () => ops.fetch(git, repoPath, remote ?? 'origin', (pct, d) => p.update(pct, d)));
      } finally {
        p.done();
      }
    },
    'git.pull': async (repoPath) => {
      const p = progress('pull', 'Pulling', repoPath);
      try {
        return await withBusy(repoPath, async () => ops.pull(git, repoPath, await pullRebaseFlag(repoPath), (pct, d) => p.update(pct, d)));
      } finally {
        p.done();
      }
    },
    'git.push': async (repoPath, opts) => {
      const p = progress('push', 'Pushing', repoPath);
      try {
        const branch = opts.branch ?? (await getCurrentBranchName(git, repoPath));
        const remote = opts.remote ?? 'origin';
        await withBusy(repoPath, () => ops.push(git, repoPath, { ...opts, remote: opts.setUpstream || opts.branch ? remote : opts.remote, branch: opts.setUpstream ? branch : opts.branch }, (pct, d) => p.update(pct, d)));
      } finally {
        p.done();
      }
    },
    'git.checkout': async (repoPath, ref, strategy) => {
      await stashBeforeCheckout(repoPath, strategy);
      await checkoutBranch(git, repoPath, ref);
    },
    'git.checkoutRemoteBranch': async (repoPath, remoteBranch, strategy) => {
      await stashBeforeCheckout(repoPath, strategy);
      return checkoutRemoteBranch(git, repoPath, remoteBranch);
    },
    'git.checkoutCommit': async (repoPath, sha) => {
      await git.run(repoPath, ['checkout', '--detach', sha]);
    },
    'git.branch.create': async (repoPath, name, startPoint, checkout, strategy) => {
      if (checkout) await stashBeforeCheckout(repoPath, strategy);
      await createBranch(git, repoPath, name, startPoint, checkout);
    },
    'git.branch.rename': async (repoPath, oldName, newName) => renameBranch(git, repoPath, oldName, newName),
    'git.branch.delete': async (repoPath, name, deleteRemote) => {
      const branches = await getBranches(git, repoPath);
      const branch = branches.find((b) => b.kind === 'local' && b.name === name);
      await deleteLocalBranch(git, repoPath, name);
      if (deleteRemote && branch?.upstream) {
        const slash = branch.upstream.indexOf('/');
        if (slash > 0) await deleteRemoteBranch(git, repoPath, branch.upstream.slice(0, slash), branch.upstream.slice(slash + 1));
      }
    },
    'git.branch.deleteRemote': async (repoPath, remote, name) => deleteRemoteBranch(git, repoPath, remote, name),
    'git.merge': async (repoPath, branch, squash) => withBusy(repoPath, () => ops.merge(git, repoPath, branch, squash)),
    'git.merge.abort': async (repoPath) => ops.mergeAbort(git, repoPath),
    'git.merge.continue': async (repoPath) => ops.mergeContinue(git, repoPath),
    'git.rebase': async (repoPath, onto) => withBusy(repoPath, () => ops.rebase(git, repoPath, onto)),
    // An AI rebase-plan apply that paused on a conflict leaves a resumable session on `rebasePlan`
    // (see RebaseApplyService); when one is pending for this repository, Continue/Abort resume or
    // fully unwind the *whole* plan instead of just the single paused `git rebase -i` step.
    'git.rebase.continue': async (repoPath, unsigned) =>
      withBusy(repoPath, () => (rebasePlan.hasPendingApply(repoPath) ? rebasePlan.continueApply(repoPath, unsigned ?? false) : ops.rebaseContinue(git, repoPath, unsigned))),
    'git.rebase.skip': async (repoPath) => withBusy(repoPath, () => ops.rebaseSkip(git, repoPath)),
    'git.rebase.abort': async (repoPath) => {
      if (rebasePlan.hasPendingApply(repoPath)) {
        await rebasePlan.abortApply(repoPath);
        return;
      }
      return ops.rebaseAbort(git, repoPath);
    },
    'git.cherryPick': async (repoPath, shas) => withBusy(repoPath, () => ops.cherryPick(git, repoPath, shas)),
    'git.cherryPick.continue': async (repoPath) => ops.cherryPickContinue(git, repoPath),
    'git.cherryPick.abort': async (repoPath) => ops.cherryPickAbort(git, repoPath),
    'git.revert': async (repoPath, sha) => withBusy(repoPath, () => ops.revert(git, repoPath, sha)),
    'git.revert.continue': async (repoPath) => ops.revertContinue(git, repoPath),
    'git.revert.abort': async (repoPath) => ops.revertAbort(git, repoPath),
    'git.squash': async (repoPath, opts) => withBusy(repoPath, () => ops.squashCommits(git, repoPath, opts)),
    'git.reorder': async (repoPath, shas, beforeSha) => withBusy(repoPath, () => ops.reorderCommits(git, repoPath, shas, beforeSha)),
    'git.reword': async (repoPath, sha, message) => withBusy(repoPath, () => ops.rewordCommit(git, repoPath, sha, message)),
    'git.dropCommit': async (repoPath, sha) => withBusy(repoPath, () => ops.dropCommit(git, repoPath, sha)),
    'git.stash.push': async (repoPath, message, includeUntracked, paths) => {
      const branch = await getCurrentBranchName(git, repoPath);
      await ops.stashPush(git, repoPath, message, includeUntracked, paths, branch);
    },
    'git.stash.pop': async (repoPath, ref) => ops.stashPop(git, repoPath, ref),
    'git.stash.apply': async (repoPath, ref) => ops.stashApply(git, repoPath, ref),
    'git.stash.drop': async (repoPath, ref) => ops.stashDrop(git, repoPath, ref),
    'git.stash.branch': async (repoPath, sha, branchName) => withBusy(repoPath, () => ops.stashBranch(git, repoPath, sha, branchName)),
    'git.tag.create': async (repoPath, name, sha, message) => ops.createTag(git, repoPath, name, sha, message),
    'git.tag.delete': async (repoPath, name, remote) => ops.deleteTag(git, repoPath, name, remote),
    'git.tag.push': async (repoPath, name) => ops.pushTag(git, repoPath, name),
    'git.conflict.markResolved': async (repoPath, paths, originals) => {
      // Capture manual resolutions (an edit, or a per-block side selection) as worked examples
      // for "Resolve remaining like …" before staging: read the current (resolved) content and
      // pair it with the pre-resolution snapshot the renderer already held. AI resolutions are
      // never captured here — they go through resolveFile, not this handler.
      if (originals) {
        for (const p of paths) {
          const original = originals[p];
          if (original === null || original === undefined) continue;
          try {
            const resolved = await readFile(toFsPath(repoPath, p), 'utf8');
            resolver.recordExample(repoPath, p, original, resolved);
          } catch (err) {
            log.warn(`Could not capture manual resolution example for ${p}: ${(err as Error).message}`);
          }
        }
      }
      await ops.markResolved(git, repoPath, paths);
    },
    'git.conflict.useSide': async (repoPath, path, side) => ops.useSide(git, repoPath, path, side),
    'git.conflict.unresolve': async (repoPath, path, original) => ops.unresolve(git, repoPath, path, original),
    'git.updateFromDefaultBranch': async (repoPath) => {
      const def = await getDefaultBranch(git, repoPath);
      if (!def) throw new Error('Could not determine the default branch.');
      const remoteRef = (await git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${def}`])) ? `origin/${def}` : def;
      return withBusy(repoPath, () => ops.merge(git, repoPath, remoteRef, false));
    },
    'git.stage': async (repoPath, paths) => stageFiles(git, repoPath, paths),
    'git.unstage': async (repoPath, paths) => unstageFiles(git, repoPath, paths),
    'git.isAncestor': async (repoPath, ancestor, descendant) => ops.isAncestor(git, repoPath, ancestor, descendant),
    'git.worktree.add': async (repoPath, opts) =>
      withBusy(repoPath, async () => {
        await addWorktree(git, repoPath, opts);
        repos.invalidateWorktrees();
        return repos.add(opts.path);
      }),
    'git.worktree.remove': async (repoPath, worktreePath, force) =>
      withBusy(repoPath, async () => {
        await removeWorktree(git, repoPath, worktreePath, force);
        repos.invalidateWorktrees();
        const existing = repos.getByPath(worktreePath);
        if (existing) await repos.remove(existing.id);
        else send('repos.changed', await repos.list());
      }),
    'git.worktree.lock': async (repoPath, worktreePath, locked, reason) => lockWorktree(git, repoPath, worktreePath, locked, reason),
    'git.worktree.prune': async (repoPath) => {
      await pruneWorktrees(git, repoPath);
      repos.invalidateWorktrees();
      send('repos.changed', await repos.list());
    },
    'git.submodule.update': async (repoPath, paths, init) =>
      withCancellableProgress('generic', init ? 'Initializing submodules' : 'Updating submodules', repoPath, (onProgress, signal) => updateSubmodules(git, repoPath, paths, init, onProgress, signal)),
    'git.submodule.sync': async (repoPath) => syncSubmodules(git, repoPath),
    'git.lfs.install': async (repoPath) => lfsInstallLocal(git, repoPath),
    'git.lfs.track': async (repoPath, pattern, track) => setLfsTracking(git, repoPath, pattern, track),
    'git.lfs.fetch': async (repoPath, mode, paths) =>
      withCancellableProgress('generic', mode === 'fetch-all' ? 'Fetching LFS objects' : 'Pulling LFS objects', repoPath, (onProgress, signal) => lfsFetch(git, repoPath, mode, paths, onProgress, signal)),
    'git.lfs.prune': async (repoPath, dryRun) => lfsPrune(git, repoPath, dryRun),
    'git.branch.deleteMany': async (repoPath, names, deleteRemote) => deleteManyBranches(git, repoPath, names, deleteRemote),
    'git.remote.prune': async (repoPath, remote) => pruneRemote(git, repoPath, remote),
    'git.gc': async (repoPath, aggressive) => withBusy(repoPath, () => runGc(git, repoPath, aggressive)),
    'git.reflog.expire': async (repoPath) => expireReflog(git, repoPath),

    // ---------------- ai ----------------
    'ai.resolve': async (repoPath, path, checkOutput) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolve(repoPath, path, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }), checkOutput);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.resolveAll': async (repoPath) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolveAll(repoPath, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.resolveAllGuided': async (repoPath) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolveAllGuided(repoPath, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.resolve.useSideForBlock': async (repoPath, path, original, ranges, blockId, side) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.useSideForBlock(repoPath, path, original, ranges, blockId, side);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'worktree' });
      }
    },
    'ai.resolve.runCheck': async (repoPath, command) => resolver.runCheck(repoPath, command),
    'ai.resolve.examples': async (repoPath) => resolver.getExamplePaths(repoPath),
    'ai.resolve.clearExamples': async (repoPath) => resolver.clearExamples(repoPath),
    'repo.checkConfig': async (repoPath) => {
      const command = (await readRepoConfig(repoPath)).postResolveCheck;
      const trust = store.getRepoConfigTrust(repoPath, command);
      return { command, trustState: trust === true ? 'trusted' : trust === false ? 'declined' : 'unknown' };
    },
    'repo.trustConfig': async (repoPath, trusted) => {
      // Bind the decision to the command that was shown in the confirmation, so a later change to .gitgood/config.json re-prompts.
      const command = (await readRepoConfig(repoPath)).postResolveCheck;
      store.setRepoConfigTrust(repoPath, trusted, command);
    },
    'ai.cancel': async () => {
      resolver.cancel();
      review.cancel();
      splitter.cancel();
      triage.cancel();
      prDraft.cancel();
      rebasePlan.cancel();
      releaseNotes.cancel();
      explain.cancel();
      errorExplain.cancel();
      nlPalette.cancel();
    },
    'ai.review.plan': async (repoPath, target) => review.plan(repoPath, target),
    'ai.review.start': async (repoPath, target, opts) => review.start(repoPath, target, opts ?? {}, (e) => send('ai.review.progress', e)),
    'ai.review.get': async (repoPath, target) => review.get(repoPath, target),
    'ai.review.dismiss': async (repoPath, runId, findingId, dismissed) => review.dismiss(repoPath, runId, findingId, dismissed),
    'ai.review.post': async (repoPath, opts) => review.post(repoPath, opts),
    'ai.review.startWorktree': async (repoPath, opts) => review.startWorktree(repoPath, opts, (e) => send('ai.review.progress', e)),
    'ai.review.worktreeStale': async (repoPath, runId) => review.worktreeStale(repoPath, runId),
    'ai.review.applySuggestion': async (repoPath, runId, findingId) => review.applySuggestion(repoPath, runId, findingId),
    'ai.explain': async (repoPath, target) => explain.explain(repoPath, target),
    'ai.explain.followUp': async (repoPath, target, history, question) => explain.followUp(repoPath, target, history, question),
    'ai.test': async () => resolver.test(),
    'ai.commitMessage': async (repoPath, files) => resolver.commitMessage(repoPath, files),
    'ai.split.preflight': async (repoPath, files) => splitter.preflight(repoPath, files),
    'ai.split.plan': async (repoPath, files, fileOnly) => splitter.plan(repoPath, files, fileOnly),
    'ai.split.apply': async (repoPath, plan) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await splitter.apply(repoPath, plan, (e) => send('ai.split.progress', e));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.split.undo': async (repoPath, startSha) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        await splitter.undo(repoPath, startSha);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.rebase.preflight': async (repoPath, base, shas) => rebasePlan.preflight(repoPath, base, shas),
    'ai.rebase.plan': async (repoPath, base, shas) => rebasePlan.plan(repoPath, base, shas),
    'ai.rebase.apply': async (repoPath, plan) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await withBusy(repoPath, () => rebasePlan.apply(repoPath, plan, (e) => send('ai.rebase.progress', e)));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.rebase.undo': async (repoPath, startSha) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        await rebasePlan.undo(repoPath, startSha);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.explainError': async (repoPath, error, retryable) => errorExplain.explainError(repoPath, error, retryable),
    'ai.prDraft': async (repoPath, input) => prDraft.draft(repoPath, input, (phase, message) => send('ai.progress', { repoPath, path: PR_DRAFT_PROGRESS_PATH, phase, message })),
    'repo.release.range': async (repoPath, query) => releaseNotes.range(repoPath, query),
    'ai.releaseNotes': async (repoPath, input) => releaseNotes.generate(repoPath, input, (phase, message) => send('ai.progress', { repoPath, path: RELEASE_NOTES_PROGRESS_PATH, phase, message })),
    'repo.changelog.insert': async (repoPath, markdown) => {
      const fsPath = toFsPath(repoPath, 'CHANGELOG.md');
      let existing: string | null = null;
      try {
        existing = await readFile(fsPath, 'utf8');
      } catch {
        existing = null;
      }
      const { content, created } = insertIntoChangelog(existing, markdown);
      await writeFile(fsPath, content, 'utf8');
      return { created };
    },
    'gh.release.create': async (repoPath, opts) => gh.releaseCreate(await requireGitHub(repoPath), opts),
    'gh.release.view': async (repoPath, tag) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? gh.releaseView(ref, tag) : null;
    },
    'ai.triage.get': async (repoPath) => triage.get(repoPath),
    'ai.triage.run': async (repoPath, numbers) => triage.run(repoPath, numbers, (e) => send('ai.triage.progress', e)),
    'ai.triage.clear': async (repoPath) => triage.clear(repoPath),
    'git.removeLockFile': async (repoPath) => errorExplain.removeLockFile(repoPath),

    // ---------------- ai command palette ----------------
    'ai.nl.plan': async (repoPath, request, priorQuestion, answer) => nlPalette.plan(repoPath, request, priorQuestion, answer),
    'ai.nl.preview': async (repoPath, step) => nlPalette.preview(repoPath, step),
    'ai.nl.run': async (repoPath, plan, confirmedStepIds) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await nlPalette.run(repoPath, plan, confirmedStepIds, (e) => send('ai.nl.progress', { ...e, repoPath }));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },

    // ---------------- auto-update ----------------
    'app.update.state': async () => updater.getState(),
    'app.update.check': async () => updater.checkNow(true),
    'app.update.download': async () => {
      const state = updater.getState();
      if (state.status === 'available') await shell.openExternal(state.url);
    },
    'app.update.install': async () => {
      const currentId = store.getState().currentRepositoryId;
      const repo = currentId ? repos.get(currentId) : null;
      const operationKind = repo ? (await freshStatus(repo.path)).operation.kind : 'none';
      const gate = canInstall({ operationKind, aiActive: resolver.isActive() || review.isActive() || triage.isActive() || prDraft.isActive() || releaseNotes.isActive() || explain.isActive() || errorExplain.isActive() || splitter.isActive() || rebasePlan.isActive() || nlPalette.isActive() });
      if (!gate.ok) throw new Error(gate.reason);
      // Ready for a real provider: reopen the same repository after the relaunch that an install causes.
      if (repo) store.updateState({ currentRepositoryId: repo.id });
      throw new Error('Automatic installation is not available in this build yet; use Download to install the update manually.');
    },
    'app.update.dismiss': async (version) => updater.dismiss(version),

    // ---------------- settings export / import / gist sync ----------------
    'settings.export': async (sections) => store.buildExport(sections, await repos.list(false)),
    'settings.exportToFile': async (path, sections) => {
      const data = store.buildExport(sections, await repos.list(false));
      await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
    },
    'settings.previewImport': async (path) => {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      return store.previewImport(raw, await repos.list(false));
    },
    'settings.import': async (path, mode, sections) => {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      const settings = store.importSettings(raw, mode, sections);
      if (sections.includes('repositories')) send('repos.changed', await repos.list());
      return settings;
    },
    'settings.sync.status': async () => settingsSync.status(),
    'settings.sync.enable': async () => settingsSync.enable(),
    'settings.sync.disable': async (deleteGist) => settingsSync.disable(deleteGist),
    'settings.sync.upload': async () => settingsSync.upload(),
    'settings.sync.download': async (mode) => {
      const settings = await settingsSync.download(mode);
      send('repos.changed', await repos.list());
      return settings;
    },
  };

  // The palette's execution step calls back into these same handlers (never a shell, never a
  // bespoke code path) so it gets identical behaviour to a manual action for the same ApiMethods key.
  nlPalette.setDispatcher(async (action, repoPath, args) => (handlers[action] as (...a: unknown[]) => Promise<unknown>)(repoPath, ...args));

  // Ensure the last commit message can be pre-filled for amend without another IPC method.
  void getLastCommitMessage;
  void stat;

  ipcMain.handle(IPC_INVOKE_CHANNEL, async (_event, method: ApiMethodName, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    const handler = handlers[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!handler) return { ok: false, error: { message: `Unknown method ${String(method)}`, command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' } };
    try {
      const value = await handler(...args);
      return { ok: true, value };
    } catch (err) {
      const info = toErrorInfo(err);
      if (info.code !== 'cancelled') log.warn(`${method} failed: ${info.message.split('\n')[0]}`);
      return { ok: false, error: info };
    }
  });
}
