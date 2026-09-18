import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { getSubmodules, hasUninitializedSubmodules, syncSubmodules, updateSubmodules } from '../../src/main/git/submodules';
import { RepositoryManager } from '../../src/main/repo/manager';
import { Store } from '../../src/main/store';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

/**
 * Builds a bare "lib" repository (the submodule source) as a sibling of
 * `root`, seeded with one commit, plus a working seed clone so a test can
 * later push a second commit (`advanceLib`) once the submodule already
 * records the first one.
 */
function makeBareLib(root: string, gitBin: string, env: NodeJS.ProcessEnv): { bareDir: string; seedDir: string; firstSha: string } {
  const run = (args: string[], cwd: string) => execFileSync(gitBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  const bareDir = join(root, 'lib.git');
  run(['init', '--bare', '-q', '-b', 'main', bareDir], root);
  const seedDir = mkdtempSync(join(tmpdir(), 'gg-lib-seed-'));
  run(['clone', '-q', bareDir, seedDir], root);
  run(['config', 'user.name', 'Test User'], seedDir);
  run(['config', 'user.email', 'test@example.com'], seedDir);
  run(['config', 'commit.gpgsign', 'false'], seedDir);
  writeFileSync(join(seedDir, 'a.txt'), '1\n');
  run(['add', '-A'], seedDir);
  run(['commit', '-q', '-m', 'lib first'], seedDir);
  const firstSha = run(['rev-parse', 'HEAD'], seedDir).trim();
  run(['push', '-q', 'origin', 'main'], seedDir);
  return { bareDir, seedDir, firstSha };
}

/** Pushes a second commit to the lib repository from its seed clone, returning its sha. */
function advanceLib(seedDir: string, gitBin: string, env: NodeJS.ProcessEnv): string {
  const run = (args: string[], cwd: string) => execFileSync(gitBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  writeFileSync(join(seedDir, 'a.txt'), '2\n');
  run(['commit', '-q', '-am', 'lib second'], seedDir);
  const secondSha = run(['rev-parse', 'HEAD'], seedDir).trim();
  run(['push', '-q', 'origin', 'main'], seedDir);
  return secondSha;
}

/** Adds `bareDir` as a submodule at `path` in `repo` and commits it (fixture setup only; uses raw git, not the app's GitClient). */
function addSubmodule(repo: TestRepo, bareDir: string, path: string): void {
  repo.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', bareDir, path]);
  repo.git(['commit', '-q', '-m', `add submodule ${path}`]);
}

/** Clones `repo` into a fresh sibling directory without `--recurse-submodules`, so any submodule stays uninitialized (an empty directory), just like a plain `git clone` of a superproject. */
function cloneFresh(repo: TestRepo, name: string): string {
  const dest = join(repo.root, name);
  execFileSync(repo.gitBin, ['clone', '-q', '-c', 'protocol.file.allow=always', repo.path, dest], { cwd: repo.root, env: repo.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return dest;
}

describe.skipIf(!hasGitSync())('submodules', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  /** A GitClient whose env permits the local (file-path) submodule transport, mirroring what a fixture is allowed to configure without the app itself hard-coding it. */
  function localSubmoduleClient(r: TestRepo): GitClient {
    return new GitClient(r.tools({ env: { ...r.env, GIT_ALLOW_PROTOCOL: 'file' } }));
  }

  it('lists a freshly cloned superproject\'s submodule as uninitialized, then initializes and updates it to up to date', async () => {
    repo = await createRepo({ commits: [{ message: 'super init', files: { 'README.md': '# super\n' } }] });
    const { bareDir, firstSha } = makeBareLib(repo.root, repo.gitBin, repo.env);
    addSubmodule(repo, bareDir, 'vendor/lib');
    const clonePath = cloneFresh(repo, 'clone');

    const git = localSubmoduleClient(repo);
    expect(await hasUninitializedSubmodules(git, clonePath)).toBe(true);

    const before = await getSubmodules(git, clonePath, null);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ path: 'vendor/lib', state: 'uninitialized', checkedOutSha: null, nested: false, recordedSha: firstSha });

    const progressCalls: { percent: number | null; description: string }[] = [];
    await updateSubmodules(git, clonePath, null, true, (percent, description) => progressCalls.push({ percent, description }));

    expect(await hasUninitializedSubmodules(git, clonePath)).toBe(false);
    const after = await getSubmodules(git, clonePath, null);
    expect(after[0]).toMatchObject({ path: 'vendor/lib', state: 'up-to-date', recordedSha: firstSha, checkedOutSha: firstSha });
  });

  it('reports "differs" when the submodule is checked out at a commit other than the one recorded', async () => {
    repo = await createRepo({ commits: [{ message: 'super init', files: { 'README.md': '# super\n' } }] });
    const { bareDir, seedDir, firstSha } = makeBareLib(repo.root, repo.gitBin, repo.env);
    addSubmodule(repo, bareDir, 'lib');
    const git = localSubmoduleClient(repo);
    await updateSubmodules(git, repo.path, null, true, () => undefined);

    const secondSha = advanceLib(seedDir, repo.gitBin, repo.env);
    const subPath = join(repo.path, 'lib');
    repo.git(['fetch', 'origin'], subPath);
    repo.git(['checkout', secondSha], subPath);

    const submodules = await getSubmodules(git, repo.path, null);
    expect(submodules[0]).toMatchObject({ state: 'differs', recordedSha: firstSha, checkedOutSha: secondSha });
  });

  it('reports "modified" when the submodule has uncommitted local changes at the recorded commit', async () => {
    repo = await createRepo({ commits: [{ message: 'super init', files: { 'README.md': '# super\n' } }] });
    const { bareDir } = makeBareLib(repo.root, repo.gitBin, repo.env);
    addSubmodule(repo, bareDir, 'lib');
    const git = localSubmoduleClient(repo);
    await updateSubmodules(git, repo.path, null, true, () => undefined);

    writeFileSync(join(repo.path, 'lib', 'a.txt'), 'uncommitted change\n');

    const submodules = await getSubmodules(git, repo.path, null);
    expect(submodules[0].state).toBe('modified');
  });

  it('syncSubmodules runs without error after the submodule has been initialized', async () => {
    repo = await createRepo({ commits: [{ message: 'super init', files: { 'README.md': '# super\n' } }] });
    const { bareDir } = makeBareLib(repo.root, repo.gitBin, repo.env);
    addSubmodule(repo, bareDir, 'lib');
    const git = localSubmoduleClient(repo);
    await updateSubmodules(git, repo.path, null, true, () => undefined);
    await expect(syncSubmodules(git, repo.path)).resolves.toBeUndefined();
  });

  it('nests "Open as repository" under the parent in the repository list via parentRepoId', async () => {
    repo = await createRepo({ commits: [{ message: 'super init', files: { 'README.md': '# super\n' } }] });
    const { bareDir } = makeBareLib(repo.root, repo.gitBin, repo.env);
    addSubmodule(repo, bareDir, 'lib');
    const git = localSubmoduleClient(repo);
    await updateSubmodules(git, repo.path, null, true, () => undefined);

    const store = new Store(join(repo.root, 'userdata'));
    store.load();
    const manager = new RepositoryManager(store, git, () => undefined);
    const parent = await manager.add(repo.path);
    const opened = await manager.openSubmodule(parent.id, join(repo.path, 'lib'));
    expect(opened.parentRepoId).toBe(parent.id);

    const list = await manager.list();
    const child = list.find((r) => r.id === opened.id);
    expect(child?.parentRepoId).toBe(parent.id);
    expect(list.filter((r) => r.id === opened.id)).toHaveLength(1);
  });
});
