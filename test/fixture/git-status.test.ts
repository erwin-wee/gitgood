import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { getStatus } from '../../src/main/git/status';
import { createRepo, hasGitSync } from '../helpers/repo';

describe.skipIf(!hasGitSync())('git status fixture', () => {
  it('reports staged, unstaged and untracked files', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'one\n', 'b.txt': 'one\n' } }] });
    try {
      await repo.write('a.txt', 'two\n'); // unstaged modification
      repo.git(['add', 'b.txt']);
      await repo.write('b.txt', 'staged then unstaged\n');
      repo.git(['add', 'b.txt']); // now staged
      await repo.write('c.txt', 'new\n'); // untracked

      const git = new GitClient(repo.tools());
      const status = await getStatus(git, repo.path);
      const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
      expect(byPath['a.txt']).toMatchObject({ status: 'modified', staged: false, unstaged: true });
      expect(byPath['b.txt']).toMatchObject({ status: 'modified', staged: true, unstaged: false });
      expect(byPath['c.txt']).toMatchObject({ status: 'untracked', staged: false, unstaged: true });
      expect(status.branch.name).toBe('main');
      expect(status.hasConflicts).toBe(false);
    } finally {
      await repo.dispose();
    }
  });

  it('reports a renamed file', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'old.txt': 'same content that is long enough\n'.repeat(3) } }] });
    try {
      repo.git(['mv', 'old.txt', 'new.txt']);
      const git = new GitClient(repo.tools());
      const status = await getStatus(git, repo.path);
      const renamed = status.files.find((f) => f.path === 'new.txt');
      expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'old.txt', staged: true });
    } finally {
      await repo.dispose();
    }
  });

  it('reports a conflicted file with the correct conflict kind during a merge', async () => {
    const repo = await createRepo({
      commits: [{ message: 'base', files: { 'f.txt': 'base\n' } }],
      branches: { feature: undefined },
    });
    try {
      repo.commit({ message: 'main change', files: { 'f.txt': 'main\n' } });
      repo.git(['checkout', 'feature']);
      repo.commit({ message: 'feature change', files: { 'f.txt': 'feature\n' } });
      repo.git(['checkout', 'main']);
      try {
        repo.git(['merge', 'feature']);
      } catch {
        // expected: merge conflict leaves the repo mid-merge
      }
      const git = new GitClient(repo.tools());
      const status = await getStatus(git, repo.path);
      expect(status.hasConflicts).toBe(true);
      const conflicted = status.files.find((f) => f.path === 'f.txt');
      expect(conflicted).toMatchObject({ status: 'conflicted', conflict: 'both-modified' });
      expect(status.operation.kind).toBe('merge');
    } finally {
      await repo.dispose();
    }
  });
});
