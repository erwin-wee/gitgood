import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { getStatus } from '../../src/main/git/status';
import { createRepo, findGit, hasGitSync, isolatedEnv, type TestRepo } from '../helpers/repo';

/**
 * Guards the isolation contract every other fixture test relies on: a
 * fixture repo's HOME points nowhere near the developer's real home, and
 * running git wrapper code against it never reads or writes the developer's
 * real ~/.gitconfig or ~/.config/gh.
 */
describe.skipIf(!hasGitSync())('fixture isolation', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('points HOME, XDG_CONFIG_HOME and GH_CONFIG_DIR at temp directories, never the real home', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const real = homedir();
    const tmpRoot = tmpdir();
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'] as const) {
      const value = repo.env[key];
      expect(value, `${key} should be set`).toBeTruthy();
      expect(value).not.toBe(real);
      expect(value!.startsWith(tmpRoot) || value!.startsWith(repo.root)).toBe(true);
    }
    expect(repo.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(repo.env.GIT_CONFIG_GLOBAL).not.toBe(join(real, '.gitconfig'));
  });

  it('never modifies the real global git config while running wrapper code against a fixture repo', async () => {
    const gitBin = await findGit();
    if (!gitBin) return;
    const before = safeReadGlobalConfig(gitBin);
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await getStatus(git, repo.path);
    // Also exercise a config write path through the isolated env directly.
    repo.git(['config', 'user.name', 'Someone Else']);
    const after = safeReadGlobalConfig(gitBin);
    expect(after).toBe(before);
  });

  it('writes fixture artifacts only under the OS temp directory, and dispose() removes them all', async () => {
    const before = await readdir(tmpdir());
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    expect(existsSync(repo.root)).toBe(true);
    expect(repo.root.startsWith(tmpdir())).toBe(true);
    const root = repo.root;
    await repo.dispose();
    expect(existsSync(root)).toBe(false);
    repo = undefined;
    const after = await readdir(tmpdir());
    // No leaked directories beyond what existed before (allowing for unrelated concurrent temp dirs).
    expect(after.filter((n) => n.startsWith('gg-repo-')).length).toBeLessThanOrEqual(before.filter((n) => n.startsWith('gg-repo-')).length + 5);
  });

  it('isolatedEnv() never reuses a real path even for a directory that happens to already exist', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'gg-isolation-check-'));
    try {
      const env = isolatedEnv(scratch);
      expect(statSync(scratch).isDirectory()).toBe(true);
      expect(env.HOME).toBe(join(scratch, 'home'));
      expect(env.GITGOOD_USER_DATA).toBe(join(scratch, 'userdata'));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

function safeReadGlobalConfig(gitBin: string): string {
  try {
    return execFileSync(gitBin, ['config', '--global', '--list'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    return '';
  }
}
