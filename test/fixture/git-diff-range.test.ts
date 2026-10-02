import { describe, expect, it } from 'vitest';
import { gitReadHandlers } from '../../src/main/core/handlers/gitRead';
import type { HandlerContext } from '../../src/main/core/handlers/context';
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

  it('shows a renamed file as a rename in the range diff, with only the real changed lines', async () => {
    const make = (tag: string) => Array.from({ length: 20 }, (_, i) => `${tag} line ${i}`).join('\n') + '\n';
    const body = make('edit');
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'old.txt': make('old'), 'edit.txt': body } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.git(['mv', 'old.txt', 'new.txt']);
      repo.git(['mv', 'edit.txt', 'moved.txt']);
      repo.commit({ message: 'rename', files: { 'moved.txt': body.replace('edit line 10\n', 'edit line ten\n') } });
      const git = new GitClient(repo.tools());
      const handlers = gitReadHandlers({ git } as unknown as HandlerContext);

      const pure = await handlers['repo.diff.range'](repo.path, 'main', 'feature', 'new.txt', {});
      expect(pure).toEqual({ kind: 'empty', reason: 'Renamed from old.txt with no content changes.' });

      const edited = await handlers['repo.diff.range'](repo.path, 'main', 'feature', 'moved.txt', {});
      if (edited.kind !== 'text') throw new Error(`expected text diff, got ${edited.kind}`);
      expect(edited.oldPath).toBe('edit.txt');
      expect(edited.newPath).toBe('moved.txt');
      const changed = edited.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context').map((l) => `${l.type}:${l.text}`);
      expect(changed).toEqual(['delete:edit line 10', 'add:edit line ten']);
    } finally {
      await repo.dispose();
    }
  });
});
