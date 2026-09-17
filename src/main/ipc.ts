import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron';
import type { ApiMethodName, ApiMethods, DiffOptions, EventPayloads, HistoryOptions } from '@shared/ipc';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc';
import type { AppSettings, CommitFile, CommitOptions, GitErrorInfo, GitHubRepoRef, IpcResult, ProgressEvent, RepositoryStatus, WorkingFile } from '@shared/types';
import { AiError } from './ai/backends';
import type { ConflictResolver } from './ai/resolver';
import { GitError, toGitErrorInfo, type GitClient } from './git/git';
import { checkoutBranch, checkoutRemoteBranch, createBranch, deleteLocalBranch, deleteRemoteBranch, getBranches, getCurrentBranchName, getDefaultBranch, renameBranch } from './git/branches';
import { applyPatchToWorktree, createCommit, getLastCommitMessage, isUnborn, stageFiles, undoLastCommit, unstageFiles } from './git/commit';
import { getCommitFileDiff, getStashFileDiff, getStashFiles, getWorkingDiff, toFsPath } from './git/diff';
import { compareRefs, getCommit, getCommitFiles, getHistory, isCommitPushed } from './git/log';
import * as ops from './git/operations';
import { getStatus } from './git/status';
import type { GhClient } from './gh/gh';
import { findEditors, openInEditor } from './integrations/editors';
import { findShells, openShell } from './integrations/shells';
import { getLogPath, log } from './logger';
import type { RepositoryManager } from './repo/manager';
import type { Store } from './store';
import type { ToolLocator } from './tools';

export interface AppContext {
  store: Store;
  tools: ToolLocator;
  git: GitClient;
  gh: GhClient;
  repos: RepositoryManager;
  resolver: ConflictResolver;
  getWindow: () => BrowserWindow | null;
  busy: Set<string>;
}

export function sendEvent<K extends keyof EventPayloads>(win: BrowserWindow | null, event: K, payload: EventPayloads[K]): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC_EVENT_CHANNEL, event, payload);
}

function toErrorInfo(err: unknown): GitErrorInfo {
  if (err instanceof AiError) {
    return { message: err.message, command: '', exitCode: null, stderr: '', stdout: '', code: err.kind === 'not-configured' ? 'ai-not-configured' : err.kind === 'cancelled' ? 'cancelled' : 'unknown' };
  }
  return toGitErrorInfo(err);
}

const commitCache = new Map<string, { commit: Awaited<ReturnType<typeof getCommit>>; files: CommitFile[] }>();

export function registerIpc(ctx: AppContext): void {
  const { store, tools, git, gh, repos, resolver } = ctx;
  const send: <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void = (event, payload) => sendEvent(ctx.getWindow(), event, payload);
  const statusCache = new Map<string, { status: RepositoryStatus; at: number }>();

  const progress = (kind: ProgressEvent['kind'], title: string, repoPath: string | null) => {
    const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emit = (percent: number | null, description: string, done = false) => send('progress', { id, kind, title, description, percent, done, repoPath });
    emit(null, 'Starting…');
    return {
      update: (percent: number | null, description: string) => emit(percent, description),
      done: () => emit(1, 'Done', true),
    };
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
      return { path, oldPath: null, status: 'modified', staged: false, unstaged: true, submodule: false, conflict: null };
    }
    return file;
  };

  const requireGitHub = async (repoPath: string): Promise<GitHubRepoRef> => {
    const ref = await repos.detectGitHub(repoPath);
    if (!ref) throw new GitError({ message: 'This repository does not have a GitHub remote.', command: '', exitCode: null, stderr: '', stdout: '', code: 'remote-not-found' });
    return ref;
  };

  const commitInfo = async (repoPath: string, sha: string) => {
    const key = `${repoPath}\0${sha}`;
    const cached = commitCache.get(key);
    if (cached) return cached;
    const commit = await getCommit(git, repoPath, sha);
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
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    'app.moveToTrash': async (p) => shell.trashItem(p),

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
    'gh.pr.template': async (repoPath) => {
      const candidates = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'];
      for (const c of candidates) {
        const p = join(repoPath, ...c.split('/'));
        if (existsSync(p)) return readFile(p, 'utf8');
      }
      const dir = join(repoPath, '.github', 'PULL_REQUEST_TEMPLATE');
      if (existsSync(dir)) {
        const files = (await readdir(dir)).filter((f) => /\.md$/i.test(f));
        if (files.length) return readFile(join(dir, files[0]), 'utf8');
      }
      return null;
    },
    'gh.gitignoreTemplates': async () => gh.gitignoreTemplates(),
    'gh.licenses': async () => gh.licenses(),
    'gh.avatar': async (email) => gh.avatarForEmail(email),
    'gh.issue.createUrl': async (repoPath) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? `${ref.url}/issues/new` : null;
    },

    // ---------------- repositories ----------------
    'repos.list': async () => repos.list(),
    'repos.add': async (path) => repos.add(path),
    'repos.remove': async (id, moveToTrash) => {
      const repo = repos.remove(id);
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
    'repo.history': async (repoPath, opts: HistoryOptions) => getHistory(git, repoPath, opts),
    'repo.commit.details': async (repoPath, sha) => {
      const { commit, files } = await commitInfo(repoPath, sha);
      return { commit, files, pushed: await isCommitPushed(git, repoPath, sha) };
    },
    'repo.commit.diff': async (repoPath, sha, path, opts: DiffOptions) => {
      const { commit, files } = await commitInfo(repoPath, sha);
      const file = files.find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: false };
      return getCommitFileDiff(git, repoPath, sha, commit.parents, file, opts);
    },
    'repo.diff.working': async (repoPath, path, opts) => getWorkingDiff(git, repoPath, await findWorkingFile(repoPath, path), opts),
    'repo.diff.stash': async (repoPath, stashRef, path, opts) => getStashFileDiff(git, repoPath, stashRef, path, opts),
    'repo.stash.files': async (repoPath, stashRef) => getStashFiles(git, repoPath, stashRef),
    'repo.compare': async (repoPath, base, head) => compareRefs(git, repoPath, base, head),
    'repo.readFile': async (repoPath, path) => readFile(toFsPath(repoPath, path), 'utf8'),
    'repo.writeFile': async (repoPath, path, content) => {
      await writeFile(toFsPath(repoPath, path), content, 'utf8');
    },
    'repo.gitignore.read': async (repoPath) => ops.readGitignore(repoPath),
    'repo.gitignore.write': async (repoPath, content) => ops.writeGitignore(repoPath, content),
    'repo.gitignore.add': async (repoPath, patterns) => ops.appendGitignore(repoPath, patterns),
    'repo.config': async (repoPath) => ops.getConfigIdentity(git, repoPath),
    'repo.config.setIdentity': async (repoPath, scope, name, email) => ops.setConfigIdentity(git, repoPath, scope, name, email),
    'repo.config.unsetLocalIdentity': async (repoPath) => ops.unsetLocalIdentity(git, repoPath),
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
    'git.rebase.continue': async (repoPath) => withBusy(repoPath, () => ops.rebaseContinue(git, repoPath)),
    'git.rebase.skip': async (repoPath) => withBusy(repoPath, () => ops.rebaseSkip(git, repoPath)),
    'git.rebase.abort': async (repoPath) => ops.rebaseAbort(git, repoPath),
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
    'git.tag.create': async (repoPath, name, sha, message) => ops.createTag(git, repoPath, name, sha, message),
    'git.tag.delete': async (repoPath, name, remote) => ops.deleteTag(git, repoPath, name, remote),
    'git.tag.push': async (repoPath, name) => ops.pushTag(git, repoPath, name),
    'git.conflict.markResolved': async (repoPath, paths) => ops.markResolved(git, repoPath, paths),
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

    // ---------------- ai ----------------
    'ai.resolve': async (repoPath, path) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolve(repoPath, path, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }));
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
    'ai.cancel': async () => resolver.cancel(),
    'ai.test': async () => resolver.test(),
    'ai.commitMessage': async (repoPath, files) => resolver.commitMessage(repoPath, files),
  };

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
