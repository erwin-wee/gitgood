import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchExists } from '../../src/main/git/branches';
import { GitClient } from '../../src/main/git/git';
import { deleteManyBranches, findLargestBlobs, getHousekeeping, getStaleBranches, expireReflog, pruneRemote, runGc } from '../../src/main/git/health';
import { RepositoryManager } from '../../src/main/repo/manager';
import { Store } from '../../src/main/store';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

/** ISO date `daysAgo` days before now, for controlling a branch's inactivity independent of the fixture's default 2024 commit dates. */
function daysAgoIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe.skipIf(!hasGitSync())('repository health: large files', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('finds a large blob that was later deleted, with its size, first commit and HEAD absence; keeps a path with spaces intact', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const bigRelPath = 'assets/my big file.bin';
    const bigFullPath = join(repo.path, ...bigRelPath.split('/'));
    mkdirSync(dirname(bigFullPath), { recursive: true });
    // A ~1 MB random buffer stands in for the "10 MB blob" scenario in tasks.md, to keep this test fast.
    writeFileSync(bigFullPath, randomBytes(1024 * 1024));
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'add big blob']);
    const addSha = repo.git(['rev-parse', 'HEAD']).trim();
    repo.git(['rm', '-q', bigRelPath]);
    repo.git(['commit', '-q', '-m', 'remove big blob']);

    const tools = repo.tools();
    const git = new GitClient(tools);
    const blobs = await findLargestBlobs(git, tools, repo.path, 25);
    const big = blobs.find((b) => b.path === bigRelPath);
    expect(big).toBeTruthy();
    expect(big!.size).toBe(1024 * 1024);
    expect(big!.firstCommitSha).toBe(addSha);
    expect(big!.atHead).toBe(false);
    expect(big!.wouldBeLfs).toBe(false);
    // Sorted largest-first.
    expect(blobs[0].sha).toBe(big!.sha);
  });

  it('reports a blob still present at HEAD as such, and honours a configured LFS pattern', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    writeFileSync(join(repo.path, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(repo.path, 'present.bin'), randomBytes(200 * 1024));
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'add present blob and lfs pattern']);

    const tools = repo.tools();
    const git = new GitClient(tools);
    const blobs = await findLargestBlobs(git, tools, repo.path, 25);
    const present = blobs.find((b) => b.path === 'present.bin');
    expect(present).toBeTruthy();
    expect(present!.atHead).toBe(true);
    expect(present!.wouldBeLfs).toBe(true);
  });

  it('respects a limit smaller than the number of blobs in history', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'a'.repeat(100), 'b.txt': 'b'.repeat(200), 'c.txt': 'c'.repeat(300) } }] });
    const tools = repo.tools();
    const git = new GitClient(tools);
    const blobs = await findLargestBlobs(git, tools, repo.path, 1);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].path).toBe('c.txt');
  });

  it('is cancellable via an AbortSignal', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const tools = repo.tools();
    const git = new GitClient(tools);
    const controller = new AbortController();
    controller.abort();
    await expect(findLargestBlobs(git, tools, repo.path, 25, controller.signal)).rejects.toMatchObject({ info: { code: 'cancelled' } });
  });
});

describe.skipIf(!hasGitSync())('repository health: stale branches', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('classifies merged, inactive and upstream-gone branches independently', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' }, date: daysAgoIso(1) }], remote: true });

    repo.git(['checkout', '-b', 'merged-branch']);
    repo.commit({ message: 'merged work', files: { 'merged.txt': '1\n' }, date: daysAgoIso(1) });
    repo.git(['checkout', 'main']);
    repo.git(['merge', '--no-ff', '-m', 'merge merged-branch', 'merged-branch']);

    repo.git(['checkout', '-b', 'old-branch', 'main']);
    repo.commit({ message: 'old work', files: { 'old.txt': '1\n' }, date: daysAgoIso(200) });
    repo.git(['checkout', 'main']);

    repo.git(['checkout', '-b', 'gone-branch', 'main']);
    repo.commit({ message: 'gone work', files: { 'gone.txt': '1\n' }, date: daysAgoIso(1) });
    repo.git(['push', '-q', '-u', 'origin', 'gone-branch']);
    repo.git(['push', '-q', 'origin', '--delete', 'gone-branch']);
    repo.git(['fetch', '-q', '--prune']);
    repo.git(['checkout', 'main']);

    const tools = repo.tools();
    const git = new GitClient(tools);
    const stale = await getStaleBranches(git, repo.path, 90);
    const byName = Object.fromEntries(stale.map((b) => [b.name, b]));
    expect(byName['merged-branch'].reason).toEqual(['merged']);
    expect(byName['old-branch'].reason).toEqual(['inactive']);
    expect(byName['gone-branch'].reason).toContain('gone');
    expect(byName['gone-branch'].upstream).toBe('origin/gone-branch');
    expect(byName['main']).toBeUndefined();
  });

  it('marks the current branch protected but still lists it when it otherwise qualifies', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' }, date: daysAgoIso(200) }] });
    const tools = repo.tools();
    const git = new GitClient(tools);
    const stale = await getStaleBranches(git, repo.path, 90);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ name: 'main', protected: true, reason: ['inactive'] });
  });
});

describe.skipIf(!hasGitSync())('repository health: bulk branch deletion', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('deletes several local branches, recording tip SHAs, and reports a per-branch failure without stopping the others', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], branches: { 'one': undefined, 'two': undefined } });
    const oneSha = repo.git(['rev-parse', 'one']).trim();
    const twoSha = repo.git(['rev-parse', 'two']).trim();
    const tools = repo.tools();
    const git = new GitClient(tools);

    const result = await deleteManyBranches(git, repo.path, ['one', 'two', 'does-not-exist'], false);
    expect(result.deleted).toEqual(expect.arrayContaining([{ name: 'one', sha: oneSha }, { name: 'two', sha: twoSha }]));
    expect(result.failed).toEqual([{ name: 'does-not-exist', message: 'Branch no longer exists.' }]);
    expect(await branchExists(git, repo.path, 'one')).toBe(false);
    expect(await branchExists(git, repo.path, 'two')).toBe(false);

    // Undo: recreate at the recorded tip.
    const { createBranch } = await import('../../src/main/git/branches');
    await createBranch(git, repo.path, 'one', oneSha, false);
    expect(await branchExists(git, repo.path, 'one')).toBe(true);
    expect(repo.git(['rev-parse', 'one']).trim()).toBe(oneSha);
  });

  it('optionally deletes the matching remote branch', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], branches: { feature: undefined }, remote: true });
    repo.git(['push', '-q', '-u', 'origin', 'feature']);
    const tools = repo.tools();
    const git = new GitClient(tools);
    await deleteManyBranches(git, repo.path, ['feature'], true);
    expect(repo.git(['branch', '--list', 'feature'], repo.remotePath!).trim()).toBe('');
  });
});

describe.skipIf(!hasGitSync())('repository health: housekeeping', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('reports numbers matching git count-objects, and reflects a gc run', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }, { message: 'second', files: { 'b.txt': '2\n' } }] });
    const tools = repo.tools();
    const git = new GitClient(tools);

    const before = await getHousekeeping(git, repo.path);
    const rawBefore = repo.git(['count-objects', '-v']);
    expect(before.looseObjectCount).toBe(parseInt(/count: (\d+)/.exec(rawBefore)![1], 10));
    expect(before.gitDirBytes).toBeGreaterThan(0);
    expect(before.lastGcAt).toBeNull();

    await runGc(git, repo.path, false);
    const after = await getHousekeeping(git, repo.path);
    expect(after.packCount).toBeGreaterThanOrEqual(1);
    expect(after.lastGcAt).not.toBeNull();
  });

  it('prunes stale remote-tracking refs and expires the reflog without throwing', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], branches: { feature: undefined }, remote: true });
    repo.git(['push', '-q', 'origin', 'feature']);
    repo.git(['push', '-q', 'origin', '--delete', 'feature']);
    const tools = repo.tools();
    const git = new GitClient(tools);
    await pruneRemote(git, repo.path, 'origin');
    expect(repo.git(['branch', '-r']).trim().split('\n').map((s) => s.trim())).not.toContain('origin/feature');

    await expireReflog(git, repo.path);
    expect(repo.git(['reflog', 'show', '--all']).trim()).toBe('');
  });
});

describe.skipIf(!hasGitSync())('RepositoryManager.work()', () => {
  let repoA: TestRepo | undefined;
  let repoB: TestRepo | undefined;
  let repoC: TestRepo | undefined;
  afterEach(async () => {
    await repoA?.dispose();
    await repoB?.dispose();
    await repoC?.dispose();
    repoA = undefined;
    repoB = undefined;
    repoC = undefined;
  });

  it('aggregates ahead branches, unpublished branches, stashes and uncommitted changes across repositories, skipping missing ones', async () => {
    repoA = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], remote: true });
    repoA.commit({ message: 'local only', files: { 'a.txt': '2\n' } });
    await repoA.write('untracked.txt', 'wip\n');

    repoB = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    repoB.git(['branch', 'unpublished-feature']);
    await repoB.write('a.txt', 'stash me\n');
    repoB.git(['stash', 'push', '-m', 'wip']);

    // A third, registered repository whose directory has since vanished from disk.
    repoC = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });

    const store = new Store(join(repoA.root, 'userdata'));
    store.load();
    const git = new GitClient(repoA.tools());
    const manager = new RepositoryManager(store, git, () => undefined);
    await manager.add(repoA.path);
    await manager.add(repoB.path);
    await manager.add(repoC.path);
    rmSync(repoC.path, { recursive: true, force: true });

    const work = await manager.work();
    const byPath = Object.fromEntries(work.map((w) => [w.repoPath, w]));
    expect(byPath[repoA.path]).toMatchObject({ aheadBranches: [{ name: 'main', ahead: 1 }], uncommittedCount: 1 });
    expect(byPath[repoB.path].unpublishedBranches).toEqual(expect.arrayContaining(['unpublished-feature', 'main']));
    expect(byPath[repoB.path].stashCount).toBe(1);
    expect(byPath[repoC.path]).toBeUndefined();
    expect(work).toHaveLength(2);
  });
});
