import { readFile } from 'node:fs/promises';
import type { CommitOptions } from '@shared/types';
import { bisectMark, bisectReset, bisectStart } from '../../git/bisect';
import { checkoutBranch, checkoutRemoteBranch, createBranch, deleteLocalBranch, deleteRemoteBranch, getBranches, getCurrentBranchName, getDefaultBranch, renameBranch } from '../../git/branches';
import { applyPatchToWorktree, createCommit, stageFiles, undoLastCommit, unstageFiles } from '../../git/commit';
import { toFsPath } from '../../git/diff';
import { deleteManyBranches, expireReflog, pruneRemote, runGc } from '../../git/health';
import { lfsFetch, lfsInstallLocal, lfsPrune, setLfsTracking } from '../../git/lfs';
import * as ops from '../../git/operations';
import { resetKeep } from '../../git/reflog';
import { syncSubmodules, updateSubmodules } from '../../git/submodules';
import { addWorktree, lockWorktree, pruneWorktrees, removeWorktree } from '../../git/worktree';
import { log } from '../../logger';
import type { ApiMethods } from '@shared/ipc';
import type { HandlerContext } from './context';

export function gitWriteHandlers(ctx: HandlerContext) {
  const { discardPaths, freshStatus, git, gitCanUpdateRefs, progress, pullRebaseFlag, rebasePlan, repos, resolver, send, stashBeforeCheckout, withBusy, withCancellableProgress } = ctx;
  return {
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
    'git.pushStack': async (repoPath) => {
      const p = progress('push', 'Pushing stack', repoPath);
      try {
        return await withBusy(repoPath, () => ops.pushStack(git, repoPath, (pct, d) => p.update(pct, d)));
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
    'git.rebase': async (repoPath, onto, updateRefs) => withBusy(repoPath, () => ops.rebase(git, repoPath, onto, !!updateRefs && gitCanUpdateRefs())),
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
    'git.resetKeep': async (repoPath, sha, stashFirst) => resetKeep(git, repoPath, sha, stashFirst),
    'git.bisect.start': async (repoPath, bad, good) => bisectStart(git, repoPath, bad, good),
    'git.bisect.mark': async (repoPath, verb, sha) => bisectMark(git, repoPath, verb, sha),
    'git.bisect.reset': async (repoPath) => bisectReset(git, repoPath),
  } satisfies Partial<ApiMethods>;
}
