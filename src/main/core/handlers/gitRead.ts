import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiffOptions, HistoryOptions } from '@shared/ipc';
import { GitError } from '../../git/git';
import { bisectHistoryRef, getBisectState } from '../../git/bisect';
import { getBlameResult, readFileAtCommit } from '../../git/blame';
import { getBranches, getDefaultBranch, getStackParents } from '../../git/branches';
import { readCommitTemplate } from '../../git/commit';
import { getCommitFileDiff, getRangeFileDiff, getRangeFiles, getStashFileDiff, getStashFiles, getWorkingDiff, toFsPath } from '../../git/diff';
import { findLargestBlobs, getHousekeeping, getStaleBranches } from '../../git/health';
import { getLfsFiles, getLfsStatus } from '../../git/lfs';
import { compareRefs, getHistory, getMatchingFiles, getPathHistory, isCommitPushed } from '../../git/log';
import * as ops from '../../git/operations';
import { getReflog, getUndoPlan } from '../../git/reflog';
import { gpgKeyExists, listGpgSecretKeys, listSshPublicKeys, normalizeSshSigningKey, sshKeyFileExists, testGpgSigning, testSshSigning } from '../../git/signing';
import { getSubmodules } from '../../git/submodules';
import { currentClient } from '../client-context';
import { listWorktrees } from '../../git/worktree';
import { readRepoConfig } from '../../repo/config';
import { assertInsideRepo, readRepoFile, writeRepoFile } from '../../repo/paths';
import type { ApiMethods } from '@shared/ipc';
import type { HandlerContext } from './context';

/** Per-client, per-repository "latest history request wins": a new `repo.history` call aborts whatever git process the same client's previous one started, never another client's. */
const historyControllers = new Map<string, AbortController>();

export function gitReadHandlers(ctx: HandlerContext) {
  const { commitInfo, findWorkingFile, freshStatus, git, gitCanUpdateRefs, repos, tools, withCancellableProgress } = ctx;
  return {
    // ---------------- repository reads ----------------
    'repo.open': async (path) => {
      const info = await repos.open(path);
      return (await readRepoConfig(path)).ai ? info : { ...info, aiConfigOff: true };
    },
    'repo.close': async (path) => repos.release(path),
    'repo.status': async (repoPath) => freshStatus(repoPath),
    'repo.branches': async (repoPath) => getBranches(git, repoPath),
    'repo.defaultBranch': async (repoPath) => getDefaultBranch(git, repoPath),
    'repo.stack': async (repoPath) => ({ parents: await getStackParents(git, repoPath), canUpdateRefs: gitCanUpdateRefs() }),
    'repo.tags': async (repoPath) => ops.getTags(git, repoPath),
    'repo.remotes': async (repoPath) => ops.getRemotes(git, repoPath),
    'repo.stashes': async (repoPath) => ops.getStashes(git, repoPath),
    'repo.history': async (repoPath, opts: HistoryOptions) => {
      const key = `${currentClient()}\0${repoPath}`;
      historyControllers.get(key)?.abort();
      const controller = new AbortController();
      historyControllers.set(key, controller);
      try {
        return await getHistory(git, repoPath, opts.ref ? opts : { ...opts, ref: await bisectHistoryRef(git, repoPath) }, controller.signal);
      } finally {
        if (historyControllers.get(key) === controller) historyControllers.delete(key);
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
      // The whole range, not just `path`: rename detection needs the old path in the diff to pair it with the new one.
      const file = (await getRangeFiles(git, repoPath, base, head)).find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: false, lfs: false };
      return getRangeFileDiff(git, repoPath, base, head, file, opts);
    },
    'repo.diff.rangeFiles': async (repoPath, base, head) => getRangeFiles(git, repoPath, base, head),
    'repo.commitTemplate': async (repoPath) => readCommitTemplate(git, repoPath),
    'repo.stash.files': async (repoPath, stashRef) => getStashFiles(git, repoPath, stashRef),
    'repo.stash.resolveRef': async (repoPath, sha) => ops.resolveStashRef(git, repoPath, sha),
    'repo.reflog': async (repoPath) => getReflog(git, repoPath),
    'repo.undoPlan': async (repoPath) => getUndoPlan(git, repoPath),
    'repo.bisect': async (repoPath) => getBisectState(git, repoPath),
    'repo.compare': async (repoPath, base, head) => compareRefs(git, repoPath, base, head),
    'repo.readFile': async (repoPath, path) => {
      toFsPath(repoPath, path);
      const buf = await readRepoFile(repoPath, path);
      if (!buf) throw new Error(`Cannot read ${path}: missing, a symbolic link, or outside the repository`);
      return buf.toString('utf8');
    },
    'repo.writeFile': async (repoPath, path, content) => {
      const fsPath = toFsPath(repoPath, path);
      await assertInsideRepo(repoPath, fsPath);
      await mkdir(dirname(fsPath), { recursive: true });
      await writeRepoFile(repoPath, path, content);
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
          const gpgPath = (await tools.ensure('gpg')).path;
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
              const gpgPath = (await tools.ensure('gpg')).path;
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
        const gpgPath = (await tools.ensure('gpg')).path;
        if (!gpgPath) return { ok: false, message: 'GPG was not found. Install GnuPG or set its location in Options → Advanced.', needsPassphrase: false };
        return testGpgSigning(gpgPath, config.key, await tools.env());
      }
      if (config.format === 'ssh') {
        const sshKeygenPath = (await tools.ensure('sshKeygen')).path;
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
    'repo.lfs.status': async (repoPath) => getLfsStatus(git, repoPath, await tools.ensure('gitLfs')),
    'repo.lfs.files': async (repoPath) => getLfsFiles(git, repoPath),
    'repo.health.largeFiles': async (repoPath, limit) => withCancellableProgress('generic', 'Scanning for large files', repoPath, (_onProgress, signal) => findLargestBlobs(git, tools, repoPath, limit, signal)),
    'repo.health.staleBranches': async (repoPath, inactiveDays) => getStaleBranches(git, repoPath, inactiveDays),
    'repo.health.housekeeping': async (repoPath) => getHousekeeping(git, repoPath),
    'repos.work': async () => repos.work(),
  } satisfies Partial<ApiMethods>;
}
