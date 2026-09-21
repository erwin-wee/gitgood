import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { addWorktree, getMainWorktreePath, isLinkedWorktree, listWorktrees, lockWorktree, pruneWorktrees, removeWorktree } from '../../src/main/git/worktree';
import { RepositoryManager, repositoryId } from '../../src/main/repo/manager';
import { RepositoryWatcher } from '../../src/main/repo/watcher';
import { Store } from '../../src/main/store';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

describe.skipIf(!hasGitSync())('git worktree operations', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('adds worktrees for an existing branch, a new branch and a detached commit, then lists them', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], branches: { other: undefined } });
    const git = new GitClient(repo.tools());
    const headSha = repo.git(['rev-parse', 'HEAD']).trim();

    const existingDir = join(repo.root, 'wt-other');
    await addWorktree(git, repo.path, { path: existingDir, branch: 'other', newBranch: null, startPoint: null, detach: false });

    const newBranchDir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: newBranchDir, branch: null, newBranch: 'feature', startPoint: 'main', detach: false });

    const detachedDir = join(repo.root, 'wt-detached');
    await addWorktree(git, repo.path, { path: detachedDir, branch: null, newBranch: null, startPoint: headSha, detach: true });

    const worktrees = await listWorktrees(git, repo.path);
    expect(worktrees).toHaveLength(4);
    expect(worktrees[0]).toMatchObject({ path: repo.path, isMain: true, branch: 'main' });
    const byPath = Object.fromEntries(worktrees.map((w) => [w.path, w]));
    expect(byPath[existingDir]).toMatchObject({ branch: 'other', isMain: false });
    expect(byPath[newBranchDir]).toMatchObject({ branch: 'feature', isMain: false });
    expect(byPath[detachedDir]).toMatchObject({ branch: null, isMain: false });
    expect(byPath[detachedDir].head.startsWith(headSha.slice(0, 7)) || byPath[detachedDir].head === headSha).toBe(true);
  });

  it('reports isCurrent for whichever worktree path is queried', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: null, newBranch: 'feature', startPoint: null, detach: false });
    const fromMain = await listWorktrees(git, repo.path);
    expect(fromMain.find((w) => w.path === repo!.path)?.isCurrent).toBe(true);
    expect(fromMain.find((w) => w.path === dir)?.isCurrent).toBe(false);
    const fromWorktree = await listWorktrees(git, dir);
    expect(fromWorktree.find((w) => w.path === dir)?.isCurrent).toBe(true);
  });

  it('fails to check out a branch that is already checked out in another worktree, classified accordingly', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], branches: { feature: undefined } });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: 'feature', newBranch: null, startPoint: null, detach: false });
    await expect(git.run(repo.path, ['checkout', 'feature'])).rejects.toMatchObject({ info: { code: 'worktree-branch-in-use' } });
  });

  it('locks, blocks removal while locked, unlocks and removes (deleting the directory)', async () => {
    const { existsSync } = await import('node:fs');
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: null, newBranch: 'feature', startPoint: null, detach: false });

    await lockWorktree(git, repo.path, dir, true, 'in use');
    let worktrees = await listWorktrees(git, repo.path);
    expect(worktrees.find((w) => w.path === dir)?.locked).toBe('in use');
    await expect(removeWorktree(git, repo.path, dir, false)).rejects.toBeTruthy();
    expect(existsSync(dir)).toBe(true);

    await lockWorktree(git, repo.path, dir, false, null);
    worktrees = await listWorktrees(git, repo.path);
    expect(worktrees.find((w) => w.path === dir)?.locked).toBeNull();

    await removeWorktree(git, repo.path, dir, false);
    expect(existsSync(dir)).toBe(false);
    worktrees = await listWorktrees(git, repo.path);
    expect(worktrees.find((w) => w.path === dir)).toBeUndefined();
  });

  it('requires --force to remove a worktree with uncommitted changes', async () => {
    const { existsSync } = await import('node:fs');
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: null, newBranch: 'feature', startPoint: null, detach: false });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.txt'), '2\n', 'utf8');
    await expect(removeWorktree(git, repo.path, dir, false)).rejects.toBeTruthy();
    expect(existsSync(dir)).toBe(true);
    await removeWorktree(git, repo.path, dir, true);
    expect(existsSync(dir)).toBe(false);
  });

  it('lists a prunable entry after its directory is deleted from disk, and prune removes the record', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: null, newBranch: 'feature', startPoint: null, detach: false });
    await rm(dir, { recursive: true, force: true });

    const worktrees = await listWorktrees(git, repo.path);
    const entry = worktrees.find((w) => w.path === dir);
    expect(entry?.prunable).toBeTruthy();

    await pruneWorktrees(git, repo.path);
    const after = await listWorktrees(git, repo.path);
    expect(after.find((w) => w.path === dir)).toBeUndefined();
  });

  it('resolves the main worktree path for both the main and a linked worktree', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: null, newBranch: 'feature', startPoint: null, detach: false });
    expect(await getMainWorktreePath(git, repo.path)).toBe(repo.path);
    expect(await getMainWorktreePath(git, dir)).toBe(repo.path);
    expect(await isLinkedWorktree(git, repo.path)).toBe(false);
    expect(await isLinkedWorktree(git, dir)).toBe(true);
  });
});

describe.skipIf(!hasGitSync())('RepositoryManager worktree nesting', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  function makeManager(r: TestRepo): RepositoryManager {
    const store = new Store(join(r.root, 'userdata'));
    store.load();
    const git = new GitClient(r.tools());
    return new RepositoryManager(store, git, () => undefined);
  }

  it('nests a worktree created outside the app under its main repository when listed', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const manager = makeManager(repo);
    const main = await manager.add(repo.path);
    expect(main.worktreeOf).toBeNull();

    const dir = join(repo.root, 'wt-feature');
    repo.git(['worktree', 'add', '-b', 'feature', dir]);

    const list = await manager.list();
    const child = list.find((r) => r.path === dir);
    expect(child).toBeTruthy();
    expect(child!.worktreeOf).toBe(main.id);
    expect(child!.name).toBe('feature');
    expect(list.filter((r) => r.id === child!.id)).toHaveLength(1); // not duplicated

    expect((await manager.worktreeChildren(main.id)).map((c) => c.path)).toEqual([dir]);
  });

  it('registers a linked worktree added directly, resolving its main repository', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const manager = makeManager(repo);
    const dir = join(repo.root, 'wt-feature');
    repo.git(['worktree', 'add', '-b', 'feature', dir]);

    // Point "add" directly at the linked worktree's own path, as if the user picked it via "Add Local Repository".
    const added = await manager.add(dir);
    expect(added.worktreeOf).toBe(repositoryId(repo.path));
    // The main repository is registered too so it shows up in the list.
    expect(manager.get(repositoryId(repo.path))).toBeTruthy();
  });

  it('removes a main repository and its registered worktrees together, leaving directories untouched', async () => {
    const { existsSync } = await import('node:fs');
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const manager = makeManager(repo);
    const main = await manager.add(repo.path);
    const dir = join(repo.root, 'wt-feature');
    repo.git(['worktree', 'add', '-b', 'feature', dir]);
    // Registering it explicitly (e.g. the user opened it) persists a worktreeOf entry.
    await manager.add(dir);
    expect(manager.getByPath(dir)?.worktreeOf).toBe(main.id);

    await manager.remove(main.id);
    expect(manager.get(main.id)).toBeNull();
    expect(manager.getByPath(dir)).toBeNull();
    const list = await manager.list();
    expect(list.find((r) => r.path === dir || r.path === repo!.path)).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(repo.path)).toBe(true);
  });
});

describe.skipIf(!hasGitSync())('RepositoryWatcher cross-worktree refs', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('notices a branch created in one worktree from another worktree watching the shared common dir (polling)', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    const dir = join(repo.root, 'wt-feature');
    await addWorktree(git, repo.path, { path: dir, branch: null, newBranch: 'feature', startPoint: null, detach: false });

    const commonDir = await getMainWorktreePathGitDir(git, repo.path);
    const worktreeGitDir = await getMainWorktreePathGitDir(git, dir);
    expect(worktreeGitDir).not.toBe(commonDir);

    const events: string[] = [];
    const watcherB = new RepositoryWatcher(dir, worktreeGitDir, (reason) => events.push(reason), { commonDir, gitPath: repo.gitBin, env: repo.env, forcePolling: true, pollIntervalMs: 500 });
    await watcherB.start();
    try {
      // Create a branch in the main worktree; its ref lives in the shared common dir.
      repo.git(['branch', 'new-shared-branch']);

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !events.some((e) => e === 'refs' || e === 'both')) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(events.some((e) => e === 'refs' || e === 'both')).toBe(true);
    } finally {
      await watcherB.stop();
    }
  });

  async function getMainWorktreePathGitDir(git: GitClient, repoPath: string): Promise<string> {
    const { getGitDir } = await import('../../src/main/git/status');
    return getGitDir(git, repoPath);
  }
});
