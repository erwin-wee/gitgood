import { describe, expect, it } from 'vitest';
import { extendGraph } from '../../src/shared/graph';
import { GitClient } from '../../src/main/git/git';
import { getHistory } from '../../src/main/git/log';
import { createRepo, hasGitSync } from '../helpers/repo';

describe.skipIf(!hasGitSync())('history in graph order', () => {
  it('lists children before parents even with clock skew, and pages lay out like one pass', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { 'a.txt': '0\n' }, date: '2020-01-01T00:00:00Z' }] });
    try {
      repo.git(['checkout', '-q', '-b', 'side']);
      // The side branch's commits carry later timestamps than the merge below.
      repo.commit({ message: 's1', files: { 's.txt': '1\n' }, date: '2031-01-01T00:00:00Z' });
      repo.commit({ message: 's2', files: { 's.txt': '2\n' }, date: '2031-01-02T00:00:00Z' });
      repo.git(['checkout', '-q', 'main']);
      repo.commit({ message: 'm1', files: { 'm.txt': '1\n' }, date: '2021-01-01T00:00:00Z' });
      repo.git(['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], undefined);
      repo.commit({ message: 'm2', files: { 'm.txt': '2\n' }, date: '2021-06-01T00:00:00Z' });

      const git = new GitClient(repo.tools());
      const opts = { ref: null, path: null, search: null, follow: false, graph: true };
      const all = (await getHistory(git, repo.path, { ...opts, skip: 0, limit: 50 })).commits;
      expect(all).toHaveLength(6);
      const index = new Map(all.map((c, i) => [c.sha, i]));
      for (const c of all) for (const p of c.parents) expect(index.get(p)!).toBeGreaterThan(index.get(c.sha)!);

      // Two pages of 3 reproduce the same order (deterministic under --skip) and the same lanes when extended incrementally.
      const p1 = await getHistory(git, repo.path, { ...opts, skip: 0, limit: 3 });
      const p2 = await getHistory(git, repo.path, { ...opts, skip: 3, limit: 3 });
      expect(p1.hasMore).toBe(true);
      const paged = [...p1.commits, ...p2.commits];
      expect(paged.map((c) => c.sha)).toEqual(all.map((c) => c.sha));
      const incremental = extendGraph(extendGraph(null, p1.commits), paged);
      expect(incremental.rows).toEqual(extendGraph(null, all).rows);
      expect(incremental.width).toBe(2);
    } finally {
      await repo.dispose();
    }
  });
});
