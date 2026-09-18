import { describe, expect, it } from 'vitest';
import { getRangePatch } from '../../src/main/git/diff';
import { GitClient } from '../../src/main/git/git';
import { createRepo, hasGitSync } from '../helpers/repo';

describe.skipIf(!hasGitSync())('getRangePatch', () => {
  it('diffs against the merge base, not the (possibly diverged) base tip', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'feature change', files: { 'a.txt': '2\n' } });
      repo.git(['checkout', 'main']);
      repo.commit({ message: 'unrelated main change', files: { 'b.txt': '1\n' } });
      const git = new GitClient(repo.tools());
      const result = await getRangePatch(git, repo.path, 'main', 'feature', 1_000_000);
      expect(result.patch).toContain('a.txt');
      expect(result.patch).not.toContain('b.txt');
      expect(result.stat).toContain('a.txt');
      expect(result.truncated).toBe(false);
    } finally {
      await repo.dispose();
    }
  });

  it('truncates the patch and sets the flag once the byte cap is reached', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'big change', files: { 'a.txt': Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n' } });
      const git = new GitClient(repo.tools());
      const full = await getRangePatch(git, repo.path, 'main', 'feature', 1_000_000);
      expect(full.truncated).toBe(false);
      const capped = await getRangePatch(git, repo.path, 'main', 'feature', 200);
      expect(capped.truncated).toBe(true);
      expect(capped.patch.length).toBe(200);
      // The stat summary is never truncated by the byte cap.
      expect(capped.stat.length).toBeGreaterThan(0);
    } finally {
      await repo.dispose();
    }
  });

  it('falls back to the given base ref when no merge base can be found', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const head = repo.git(['rev-parse', 'HEAD']).trim();
      const result = await getRangePatch(git, repo.path, head, head, 1_000_000);
      expect(result.patch).toBe('');
      expect(result.truncated).toBe(false);
    } finally {
      await repo.dispose();
    }
  });
});
