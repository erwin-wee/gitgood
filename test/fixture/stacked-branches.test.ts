import { join } from 'node:path';
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

  it('builds a lease push for the whole stack and refuses option-like names', () => {
    expect(pushStackArgs('origin', ['a', 'b', 'c'])).toEqual(['push', '--progress', '--force-with-lease', 'origin', 'a', 'b', 'c']);
    expect(() => pushStackArgs('origin', ['-f'])).toThrow();
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

  const remoteHeads = (r: TestRepo) => r.git(['--git-dir', r.remotePath!, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']).trim().split('\n').sort();
  const upstream = (r: TestRepo, b: string) => r.git(['config', '--get-regexp', `^branch\\.${b}\\.(remote|merge)$`]).trim().split('\n').sort();

  it('publishes to origin, not to ".", when the child was created with --track <parent>, and keeps local tracking', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'base.txt': '1\n' } }], remote: true });
    repo.git(['checkout', '-q', '-b', 'parent']);
    repo.commit({ message: 'parent work', files: { 'p.txt': 'p\n' } });
    repo.git(['push', '-q', '-u', 'origin', 'parent']);
    repo.git(['checkout', '-q', '-b', 'child', '--track', 'parent']);
    repo.commit({ message: 'child work', files: { 'c.txt': 'c\n' } });
    repo.git(['checkout', '-q', '-b', 'grandchild']);
    repo.commit({ message: 'grandchild work', files: { 'g.txt': 'g\n' } });
    expect(repo.git(['config', '--get', 'branch.child.remote']).trim()).toBe('.');
    const git = new GitClient(repo.tools());

    expect(await pushStack(git, repo.path, () => undefined)).toEqual(['parent', 'child', 'grandchild']);
    const heads = remoteHeads(repo);
    for (const name of ['parent', 'child', 'grandchild']) expect(heads).toContain(`${name} ${repo.git(['rev-parse', name]).trim()}`);
    expect(upstream(repo, 'child')).toEqual(['branch.child.merge refs/heads/parent', 'branch.child.remote .']);
    expect(upstream(repo, 'parent')).toEqual(['branch.parent.merge refs/heads/parent', 'branch.parent.remote origin']);
    expect(upstream(repo, 'grandchild')).toEqual(['branch.grandchild.merge refs/heads/grandchild', 'branch.grandchild.remote origin']);
  });

  it('honours remote.pushDefault over the upstream remote', async () => {
    repo = await stackedRepo(true);
    const fork = join(repo.root, 'fork.git');
    repo.git(['init', '-q', '--bare', fork], repo.root);
    repo.git(['remote', 'add', 'fork', fork]);
    repo.git(['config', 'remote.pushDefault', 'fork']);
    const git = new GitClient(repo.tools());
    await pushStack(git, repo.path, () => undefined);
    expect(repo.git(['--git-dir', fork, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n').sort()).toEqual(['a', 'b', 'c']);
    expect(remoteHeads(repo).map((l) => l.split(' ')[0])).toEqual(['main']);
    expect(repo.git(['config', '--get', 'branch.c.remote']).trim()).toBe('fork');
  });

  it('refuses instead of pushing when there is no real remote or several unconfigured ones', async () => {
    repo = await stackedRepo();
    repo.git(['config', 'branch.b.remote', '.']);
    repo.git(['config', 'branch.b.merge', 'refs/heads/a']);
    const git = new GitClient(repo.tools());
    await expect(pushStack(git, repo.path, () => undefined)).rejects.toThrow(/no remote/);

    repo.git(['remote', 'add', 'one', repo.path]);
    repo.git(['remote', 'add', 'two', repo.path]);
    await expect(pushStack(git, repo.path, () => undefined)).rejects.toThrow(/Several remotes/);
    expect(repo.git(['config', '--get', 'branch.b.remote']).trim()).toBe('.');
  });
});
