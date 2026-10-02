import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bisectHistoryRef, bisectMark, bisectReset, bisectStart, getBisectState } from '../src/main/git/bisect';
import { GitClient } from '../src/main/git/git';
import { pull } from '../src/main/git/operations';
import { getReflog, getUndoPlan, planUndo, resetKeep } from '../src/main/git/reflog';
import { createRepo, hasGitSync } from './helpers/repo';

describe.skipIf(!hasGitSync())('reflog', () => {
  it('lists HEAD entries newest first with action, message and sha', async () => {
    const repo = await createRepo({ commits: [{ message: 'one', files: { a: '1' } }, { message: 'two', files: { a: '2' } }] });
    try {
      const git = new GitClient(repo.tools());
      const two = repo.git(['rev-parse', 'HEAD']).trim();
      repo.git(['commit', '--amend', '-m', 'two amended']);
      repo.git(['checkout', '-q', '-b', 'side']);
      repo.git(['checkout', '-q', 'main']);
      repo.git(['reset', '-q', '--hard', 'HEAD~1']);
      const entries = await getReflog(git, repo.path);
      expect(entries.slice(0, 5).map((e) => [e.action, e.message])).toEqual([
        ['reset', 'moving to HEAD~1'],
        ['checkout', 'moving from side to main'],
        ['checkout', 'moving from main to side'],
        ['commit (amend)', 'two amended'],
        ['commit', 'two'],
      ]);
      expect(entries.map((e) => e.index)).toEqual(entries.map((_, i) => i));
      expect(entries[4].sha).toBe(two);
      expect(entries[0].sha).toBe(repo.git(['rev-parse', 'HEAD']).trim());
      expect(entries[0].timestamp).toBeGreaterThan(0);
    } finally {
      await repo.dispose();
    }
  });

  it('undo-last of a commit, amend or reset restores the previous HEAD', async () => {
    const repo = await createRepo({ commits: [{ message: 'zero', files: { a: '0' } }, { message: 'one', files: { a: '1' } }] });
    try {
      const git = new GitClient(repo.tools());
      for (const step of [
        () => repo.commit({ message: 'two', files: { a: '2' } }),
        () => repo.git(['commit', '--amend', '--allow-empty', '-m', 'two b']),
        () => repo.git(['reset', '-q', '--hard', 'HEAD~1']),
      ]) {
        const before = repo.git(['rev-parse', 'HEAD']).trim();
        step();
        const plan = await getUndoPlan(git, repo.path);
        expect(plan?.kind).toBe('reset');
        if (plan?.kind !== 'reset') throw new Error('unreachable');
        await resetKeep(git, repo.path, plan.target.sha, false);
        expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(before);
        // the branch keeps pointing at the restored commit and the tree matches it
        expect(repo.git(['status', '--porcelain']).trim()).toBe('');
      }
    } finally {
      await repo.dispose();
    }
  });

  it('describes the undone entry and skips no-op resets', async () => {
    const repo = await createRepo({ commits: [{ message: 'one', files: { a: '1' } }] });
    try {
      const git = new GitClient(repo.tools());
      repo.commit({ message: 'two', files: { a: '2' } });
      repo.git(['reset', '-q', '--hard', 'HEAD']);
      const plan = await getUndoPlan(git, repo.path);
      expect(plan).toMatchObject({ kind: 'reset', description: 'Commit: two' });
    } finally {
      await repo.dispose();
    }
  });

  it('undoes a whole rebase, not just its last replayed commit', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { a: '1' } }] });
    try {
      const git = new GitClient(repo.tools());
      repo.git(['checkout', '-q', '-b', 'feat']);
      repo.commit({ message: 'f1', files: { f1: '1' } });
      repo.commit({ message: 'f2', files: { f2: '1' } });
      const before = repo.git(['rev-parse', 'HEAD']).trim();
      repo.git(['checkout', '-q', 'main']);
      repo.commit({ message: 'm1', files: { m1: '1' } });
      repo.git(['checkout', '-q', 'feat']);
      repo.git(['rebase', 'main']);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).not.toBe(before);
      const plan = await getUndoPlan(git, repo.path);
      expect(plan).toMatchObject({ kind: 'reset', description: 'Rebase' });
      if (plan?.kind !== 'reset') throw new Error('unreachable');
      await resetKeep(git, repo.path, plan.target.sha, false);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(before);
    } finally {
      await repo.dispose();
    }
  });

  it('undoes only the latest GitGood pull --rebase run (keeping local commits), not the previous consecutive one', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { a: '1' } }], remote: true });
    try {
      const git = new GitClient(repo.tools());
      const other = join(repo.root, 'other');
      repo.git(['clone', '-q', repo.remotePath!, other], repo.root);
      repo.git(['config', 'user.name', 'Other'], other);
      repo.git(['config', 'user.email', 'other@example.com'], other);
      const upstream = (name: string) => {
        repo.git(['commit', '-q', '--allow-empty', '-m', name], other);
        repo.git(['push', '-q', 'origin', 'main'], other);
      };
      repo.commit({ message: 'l1', files: { l1: '1' } });
      repo.commit({ message: 'l2', files: { l2: '1' } });
      upstream('u1');
      await pull(git, repo.path, true, () => undefined);
      const beforeSecond = repo.git(['rev-parse', 'HEAD']).trim();
      upstream('u2');
      await pull(git, repo.path, true, () => undefined);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).not.toBe(beforeSecond);

      const second = await getUndoPlan(git, repo.path);
      expect(second).toMatchObject({ kind: 'reset', description: 'Pull (rebase)' });
      if (second?.kind !== 'reset') throw new Error('unreachable');
      expect(second.target.sha).toBe(beforeSecond);
      await resetKeep(git, repo.path, second.target.sha, false);
      expect(repo.git(['log', '--format=%s', '-n', '3']).trim().split('\n')).toEqual(['l2', 'l1', 'u1']);
    } finally {
      await repo.dispose();
    }
  });

  it('undoes only the latest of two consecutive plain rebases', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { a: '1' } }] });
    try {
      const git = new GitClient(repo.tools());
      repo.git(['checkout', '-q', '-b', 'feat']);
      repo.commit({ message: 'f1', files: { f1: '1' } });
      repo.git(['checkout', '-q', 'main']);
      repo.commit({ message: 'm1', files: { m1: '1' } });
      repo.git(['checkout', '-q', 'feat']);
      repo.git(['rebase', '-q', 'main']);
      const afterFirst = repo.git(['rev-parse', 'HEAD']).trim();
      // Moves main without touching HEAD, so the two rebases are back to back in the HEAD reflog.
      repo.git(['update-ref', 'refs/heads/main', repo.git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'm2']).trim()]);
      repo.git(['rebase', '-q', 'main']);

      const second = await getUndoPlan(git, repo.path);
      if (second?.kind !== 'reset') throw new Error('expected reset');
      expect(second.target.sha).toBe(afterFirst);
    } finally {
      await repo.dispose();
    }
  });

  it('skips an aborted rebase and plans from the operation before it', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { a: '1' } }] });
    try {
      const git = new GitClient(repo.tools());
      repo.git(['checkout', '-q', '-b', 'feat']);
      repo.commit({ message: 'f1', files: { a: 'feat' } });
      repo.git(['checkout', '-q', 'main']);
      repo.commit({ message: 'm1', files: { a: 'main' } });
      repo.git(['checkout', '-q', 'feat']);
      expect(() => repo.git(['rebase', '-q', 'main'])).toThrow();
      repo.git(['rebase', '--abort']);
      expect(await getUndoPlan(git, repo.path)).toMatchObject({ kind: 'checkout', ref: 'main', isBranch: true });
    } finally {
      await repo.dispose();
    }
  });

  it('offers switching back after a checkout, naming a branch or a detached commit', async () => {
    const repo = await createRepo({ commits: [{ message: 'one', files: { a: '1' } }], branches: { other: undefined } });
    try {
      const git = new GitClient(repo.tools());
      repo.git(['checkout', '-q', 'other']);
      expect(await getUndoPlan(git, repo.path)).toMatchObject({ kind: 'checkout', ref: 'main', isBranch: true });
      repo.git(['checkout', '-q', '--detach']);
      const detachedAt = repo.git(['rev-parse', 'HEAD']).trim();
      repo.git(['checkout', '-q', 'main']);
      expect(await getUndoPlan(git, repo.path)).toMatchObject({ kind: 'checkout', ref: detachedAt, isBranch: false });
    } finally {
      await repo.dispose();
    }
  });

  it('has nothing to undo for a fresh repository', () => {
    expect(planUndo([{ index: 0, sha: 'a'.repeat(40), action: 'commit (initial)', message: 'one', timestamp: 0 }], new Set())).toBeNull();
  });

  it('reset --keep keeps unrelated local changes and refuses overlapping ones unless stashing first', async () => {
    const repo = await createRepo({ commits: [{ message: 'one', files: { a: '1', b: '1' } }, { message: 'two', files: { a: '2' } }] });
    try {
      const git = new GitClient(repo.tools());
      const first = repo.git(['rev-parse', 'HEAD~1']).trim();
      await repo.write('b', 'local edit');
      await resetKeep(git, repo.path, first, false);
      expect(repo.git(['status', '--porcelain']).trim()).toBe('M b');

      repo.git(['checkout', '-q', 'main']);
      repo.git(['reset', '-q', '--hard', 'ORIG_HEAD']);
      await repo.write('a', 'conflicting local edit');
      await expect(resetKeep(git, repo.path, first, false)).rejects.toMatchObject({ info: { code: 'local-changes-overwritten' } });
      await resetKeep(git, repo.path, first, true);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(first);
      expect(repo.git(['stash', 'list']).trim()).not.toBe('');
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('bisect', () => {
  it('walks an 8-commit history to the first bad commit, then reset restores the branch', async () => {
    const repo = await createRepo({
      commits: Array.from({ length: 8 }, (_, i) => ({ message: `c${i + 1}`, files: { [`f${i + 1}`]: 'x', ...(i + 1 >= 5 ? { bug: 'yes' } : {}) } })),
    });
    try {
      const git = new GitClient(repo.tools());
      const head = repo.git(['rev-parse', 'HEAD']).trim();
      const c1 = repo.git(['rev-parse', 'HEAD~7']).trim();
      const c5 = repo.git(['rev-parse', 'HEAD~3']).trim();
      expect(await bisectHistoryRef(git, repo.path)).toBeNull();
      expect(await getBisectState(git, repo.path)).toBeNull();

      await bisectStart(git, repo.path, head, c1);
      expect(await bisectHistoryRef(git, repo.path)).toBe('main');
      let state = await getBisectState(git, repo.path);
      expect(state).toMatchObject({ bad: head, good: [c1], firstBad: null });
      expect(state?.remaining).toBeGreaterThan(0);
      expect(state?.steps).toBeGreaterThan(0);
      await expect(bisectStart(git, repo.path, head, c1)).rejects.toThrow(/already in progress/);

      for (let guard = 0; guard < 8 && !state?.firstBad; guard += 1) {
        await bisectMark(git, repo.path, existsSync(join(repo.path, 'bug')) ? 'bad' : 'good', null);
        state = await getBisectState(git, repo.path);
      }
      expect(state?.firstBad).toEqual({ sha: c5, summary: 'c5' });

      await bisectReset(git, repo.path);
      expect(await getBisectState(git, repo.path)).toBeNull();
      expect(repo.git(['branch', '--show-current']).trim()).toBe('main');
      expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(head);
    } finally {
      await repo.dispose();
    }
  });

  it('marks explicit commits and rolls back a start that cannot check out', async () => {
    const repo = await createRepo({ commits: Array.from({ length: 4 }, (_, i) => ({ message: `c${i + 1}`, files: { [`f${i + 1}`]: 'x' } })) });
    try {
      const git = new GitClient(repo.tools());
      const c1 = repo.git(['rev-parse', 'HEAD~3']).trim();
      const c4 = repo.git(['rev-parse', 'HEAD']).trim();
      await expect(bisectStart(git, repo.path, c4, 'does-not-exist')).rejects.toThrow(/not a commit/);
      expect(await getBisectState(git, repo.path)).toBeNull();

      // The midpoint checkout would delete f4, which has a local edit: git refuses and nothing is left half-started.
      await repo.write('f4', 'local edit');
      await expect(bisectStart(git, repo.path, c4, c1)).rejects.toThrow();
      expect(await getBisectState(git, repo.path)).toBeNull();
      expect(repo.git(['branch', '--show-current']).trim()).toBe('main');
      repo.git(['checkout', '--', 'f4']);

      await bisectStart(git, repo.path, c4, c1);
      await bisectMark(git, repo.path, 'good', c1);
      await bisectMark(git, repo.path, 'skip', null);
      expect((await getBisectState(git, repo.path))?.good).toContain(c1);
      await bisectReset(git, repo.path);
    } finally {
      await repo.dispose();
    }
  });
});
