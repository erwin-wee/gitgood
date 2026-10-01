import { existsSync } from 'node:fs';
import type { AppSettings, Commit, CommitFile, GitHubRepoRef, ProgressEvent, RepositoryStatus, WorkingFile } from '@shared/types';
import { compareVersions } from '@shared/util';
import { GitError } from '../../git/git';
import { isUnborn } from '../../git/commit';
import { toFsPath } from '../../git/diff';
import { getCommit, getCommitFiles } from '../../git/log';
import * as ops from '../../git/operations';
import { getStatus } from '../../git/status';
import { repoSelector } from '../../gh/gh';
import { log } from '../../logger';
import type { HandlerDeps } from './index';

const commitCache = new Map<string, { commit: Commit; files: CommitFile[] }>();
/** Long-running operations (submodule update, LFS fetch/pull) keyed by their progress event id, cancellable via `app.operations.cancel`. */
export const operationControllers = new Map<string, AbortController>();

export function createHandlerContext(deps: HandlerDeps) {
  const { git, host, repos, store, tools } = deps;
  const send = deps.emit;
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
    deps.busy.add(key);
    try {
      return await fn();
    } finally {
      deps.busy.delete(key);
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

  /** `git rebase --update-refs` arrived in git 2.38. */
  const gitCanUpdateRefs = (): boolean => {
    const version = tools.current().git.version;
    return !!version && compareVersions(version, '2.38.0') >= 0;
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
            await host.trashItem(fs);
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

  return { ...deps, send, progress, withCancellableProgress, withBusy, freshStatus, findWorkingFile, requireGitHub, issueSelector, commitInfo, pullRebaseFlag, gitCanUpdateRefs, stashBeforeCheckout, discardPaths };
}

export type HandlerContext = ReturnType<typeof createHandlerContext>;
