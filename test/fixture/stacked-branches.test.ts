import { afterEach, describe, expect, it } from 'vitest';
import { getStackParents } from '../../src/main/git/branches';
import { GitClient } from '../../src/main/git/git';
import { pushStack, pushStackArgs, rebase } from '../../src/main/git/operations';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

/** main -> a -> b -> c, each branch one commit on top of the previous one; c is checked out. */
async function stackedRepo(remote = false): Promise<TestRepo> {
  const repo = await createRepo({ commits: [{ message: 'init', files: { 'base.txt': '1\n' } }], remote });
  for (const name of ['a', 'b', 'c']) {
    repo.git(['checkout', '-q', '-b', name]);
    repo.commit({ message: `work on ${name}`, files: { [`${name}.txt`]: `${name}\n` } });
  }
  return repo;
}

describe.skipIf(!hasGitSync())('stacked branches', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('detects the branches below the current one, oldest first', async () => {
    repo = await stackedRepo();
    const git = new GitClient(repo.tools());
    expect(await getStackParents(git, repo.path)).toEqual(['a', 'b']);
    repo.git(['checkout', '-q', 'b']);
    expect(await getStackParents(git, repo.path)).toEqual(['a']);
    repo.git(['checkout', '-q', 'a']);
    expect(await getStackParents(git, repo.path)).toEqual([]);
    repo.git(['checkout', '-q', 'main']);
    expect(await getStackParents(git, repo.path)).toEqual([]);
  });

  it('does not count a sibling at the same commit, an unrelated branch, or a merged parent', async () => {
    repo = await stackedRepo();
    repo.git(['branch', 'c-twin']);
    repo.git(['branch', 'other', 'main']);
    const git = new GitClient(repo.tools());
    expect(await getStackParents(git, repo.path)).toEqual(['a', 'b']);
    // Once `a` lands on main it is no longer part of the stack.
    repo.git(['checkout', '-q', 'main']);
    repo.git(['merge', '-q', '--ff-only', 'a']);
    repo.git(['checkout', '-q', 'c']);
    expect(await getStackParents(git, repo.path)).toEqual(['b']);
  });

  it('rebase --update-refs moves the stack along; a plain rebase leaves the parents behind', async () => {
    repo = await stackedRepo();
    repo.git(['checkout', '-q', 'main']);
    repo.commit({ message: 'main moves on', files: { 'main.txt': 'x\n' } });
    repo.git(['checkout', '-q', 'c']);
    const git = new GitClient(repo.tools());
    const isAncestor = (a: string, b: string) => {
      try {
        repo!.git(['merge-base', '--is-ancestor', a, b]);
        return true;
      } catch {
        return false;
      }
    };

    const before = repo.git(['rev-parse', 'a', 'b']);
    expect(await rebase(git, repo.path, 'main', true)).toEqual({ status: 'complete' });
    expect(repo.git(['rev-parse', 'a', 'b'])).not.toBe(before);
    expect(isAncestor('main', 'a') && isAncestor('a', 'b') && isAncestor('b', 'c')).toBe(true);
    expect(await getStackParents(git, repo.path)).toEqual(['a', 'b']);

    // Same setup, no --update-refs: a and b stay on the old main.
    repo.git(['reset', '-q', '--hard', 'ORIG_HEAD']);
    repo.git(['branch', '-f', 'a', before.split('\n')[0]]);
    repo.git(['branch', '-f', 'b', before.split('\n')[1]]);
    await rebase(git, repo.path, 'main');
    expect(repo.git(['rev-parse', 'a', 'b'])).toBe(before);
    expect(isAncestor('main', 'a')).toBe(false);
  });

  it('builds a lease push for the whole stack, adding --set-upstream only when asked', () => {
    expect(pushStackArgs('origin', ['a', 'b', 'c'], false)).toEqual(['push', '--progress', '--force-with-lease', 'origin', 'a', 'b', 'c']);
    expect(pushStackArgs('origin', ['a', 'c'], true)).toEqual(['push', '--progress', '--force-with-lease', '--set-upstream', 'origin', 'a', 'c']);
    expect(() => pushStackArgs('origin', ['-f'], false)).toThrow();
  });

  it('pushes every stack branch to the remote, including unpublished ones', async () => {
    repo = await stackedRepo(true);
    repo.git(['push', '-q', 'origin', 'a']);
    const git = new GitClient(repo.tools());
    const pushed = await pushStack(git, repo.path, () => undefined);
    expect(pushed).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) {
      expect(repo.git(['--git-dir', repo.remotePath!, 'rev-parse', `refs/heads/${name}`])).toBe(repo.git(['rev-parse', name]));
    }
    expect(repo.git(['rev-parse', '--abbrev-ref', 'c@{upstream}']).trim()).toBe('origin/c');
  });
});
