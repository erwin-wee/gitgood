import { describe, expect, it } from 'vitest';
import { EMPTY_HISTORY_QUERY } from '../../src/shared/types';
import { GitClient } from '../../src/main/git/git';
import { createCommit, getLastCommitMessage, undoLastCommit } from '../../src/main/git/commit';
import { getCommitFiles, getCommitPatch, getHistory, getMatchingFiles, getRecentFileHistory, isCommitPushed, mergeBase } from '../../src/main/git/log';
import { createRepo, hasGitSync } from '../helpers/repo';

describe.skipIf(!hasGitSync())('history paging and search', () => {
  it('pages through history and reports hasMore', async () => {
    const repo = await createRepo({
      commits: Array.from({ length: 5 }, (_, i) => ({ message: `commit ${i + 1}`, files: { 'f.txt': `content ${i + 1}\n` } })),
    });
    try {
      const git = new GitClient(repo.tools());
      const page1 = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 2, path: null, search: null });
      expect(page1.commits.map((c) => c.summary)).toEqual(['commit 5', 'commit 4']);
      expect(page1.hasMore).toBe(true);
      const page2 = await getHistory(git, repo.path, { ref: null, skip: 2, limit: 2, path: null, search: null });
      expect(page2.commits.map((c) => c.summary)).toEqual(['commit 3', 'commit 2']);
      const page3 = await getHistory(git, repo.path, { ref: null, skip: 4, limit: 2, path: null, search: null });
      expect(page3.commits.map((c) => c.summary)).toEqual(['commit 1']);
      expect(page3.hasMore).toBe(false);
    } finally {
      await repo.dispose();
    }
  });

  it('finds commits by message and by SHA', async () => {
    const repo = await createRepo({
      commits: [
        { message: 'Fix the login bug', files: { 'a.txt': '1\n' } },
        { message: 'Add feature flag', files: { 'a.txt': '2\n' } },
      ],
    });
    try {
      const git = new GitClient(repo.tools());
      const bySubject = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: null, search: 'login' });
      expect(bySubject.commits.map((c) => c.summary)).toEqual(['Fix the login bug']);
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const bySha = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: null, search: sha });
      expect(bySha.commits[0].sha).toBe(sha);
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('history content/regex search (pickaxe)', () => {
  async function needleRepo() {
    return createRepo({
      commits: [
        { message: 'add needle', files: { 'a.txt': 'needle here\nother line\n' } },
        { message: 'change needle line', files: { 'a.txt': 'needle there\nother line\n' } },
        { message: 'remove needle', files: { 'a.txt': 'other line\n' } },
      ],
    });
  }

  it('-S (content:) finds only the add and remove commits', async () => {
    const repo = await needleRepo();
    try {
      const git = new GitClient(repo.tools());
      const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: null, search: null, follow: false, query: { ...EMPTY_HISTORY_QUERY, content: 'needle' } });
      expect(page.commits.map((c) => c.summary).sort()).toEqual(['add needle', 'remove needle'].sort());
    } finally {
      await repo.dispose();
    }
  });

  it('-G (regex:) also finds the commit that only changed the matching line', async () => {
    const repo = await needleRepo();
    try {
      const git = new GitClient(repo.tools());
      const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: null, search: null, follow: false, query: { ...EMPTY_HISTORY_QUERY, diffRegex: 'needle' } });
      expect(page.commits.map((c) => c.summary).sort()).toEqual(['add needle', 'change needle line', 'remove needle'].sort());
    } finally {
      await repo.dispose();
    }
  });

  it('combines author, date and path filters with free-text message search (AND semantics)', async () => {
    const repo = await createRepo({
      commits: [
        { message: 'unrelated', files: { 'other.txt': '1\n' }, date: '2025-01-01T00:00:00Z' },
        { message: 'fix bug in app', files: { 'src/app.ts': '1\n' }, date: '2026-02-01T00:00:00Z' },
        { message: 'fix bug elsewhere', files: { 'other.txt': '2\n' }, date: '2026-02-02T00:00:00Z' },
      ],
    });
    try {
      const git = new GitClient(repo.tools());
      const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: null, search: 'fix', follow: false, query: { ...EMPTY_HISTORY_QUERY, author: 'Test User', after: '2026-01-01', paths: ['src/app.ts'] } });
      expect(page.commits.map((c) => c.summary)).toEqual(['fix bug in app']);
    } finally {
      await repo.dispose();
    }
  });

  it('getMatchingFiles narrows to the files whose diff actually matched', async () => {
    const repo = await createRepo({
      commits: [
        { message: 'two files', files: { 'a.txt': 'needle\n', 'b.txt': 'unrelated\n' } },
      ],
    });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const files = await getMatchingFiles(git, repo.path, sha, { content: 'needle', contentRegex: false, diffRegex: null });
      expect(files).toEqual(['a.txt']);
    } finally {
      await repo.dispose();
    }
  });

  it('cancels an in-flight history request via AbortSignal', async () => {
    const repo = await createRepo({ commits: [{ message: 'one', files: { 'a.txt': '1\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const controller = new AbortController();
      controller.abort();
      await expect(getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: null, search: null, follow: false }, controller.signal)).rejects.toMatchObject({ info: { code: 'cancelled' } });
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('commit creation, undo and amend', () => {
  it('creates a commit from a partial file selection', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'base\n', 'b.txt': 'base\n' } }] });
    try {
      await repo.write('a.txt', 'changed a\n');
      await repo.write('b.txt', 'changed b\n');
      const git = new GitClient(repo.tools());
      const sha = await createCommit(git, repo.path, { summary: 'Update a only', description: '', files: ['a.txt'], partialPatches: {}, coAuthors: [], amend: false }, false);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const files = await getCommitFiles(git, repo.path, sha, [repo.git(['rev-parse', 'HEAD~1']).trim()]);
      expect(files.map((f) => f.path)).toEqual(['a.txt']);
      // b.txt's edit remains unstaged, uncommitted.
      const status = repo.git(['status', '--porcelain']).trim();
      expect(status).toContain('b.txt');
    } finally {
      await repo.dispose();
    }
  });

  it('undoes the last commit, keeping changes staged', async () => {
    const repo = await createRepo({ commits: [{ message: 'first', files: { 'a.txt': '1\n' } }, { message: 'second', files: { 'a.txt': '2\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      await undoLastCommit(git, repo.path);
      const log = await getLastCommitMessage(git, repo.path);
      expect(log?.summary).toBe('first');
      const staged = repo.git(['diff', '--cached', '--name-only']).trim();
      expect(staged).toBe('a.txt');
    } finally {
      await repo.dispose();
    }
  });

  it('amends the last commit message', async () => {
    const repo = await createRepo({ commits: [{ message: 'typo mesage', files: { 'a.txt': '1\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      await createCommit(git, repo.path, { summary: 'fixed message', description: '', files: [], partialPatches: {}, coAuthors: [], amend: true }, false);
      const log = await getLastCommitMessage(git, repo.path);
      expect(log?.summary).toBe('fixed message');
      expect(repo.git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    } finally {
      await repo.dispose();
    }
  });

  it('reports whether a commit has been pushed', async () => {
    const repo = await createRepo({ commits: [{ message: 'pushed', files: { 'a.txt': '1\n' } }], remote: true });
    try {
      const git = new GitClient(repo.tools());
      const pushedSha = repo.git(['rev-parse', 'HEAD']).trim();
      expect(await isCommitPushed(git, repo.path, pushedSha)).toBe(true);
      const localSha = repo.commit({ message: 'local only', files: { 'a.txt': '2\n' } });
      expect(await isCommitPushed(git, repo.path, localSha)).toBe(false);
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('getCommitPatch', () => {
  it('includes every file for an ordinary commit and reports no truncation under a generous cap', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'base\n' } }, { message: 'two files', files: { 'a.txt': 'changed\n', 'b.txt': 'new\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const result = await getCommitPatch(git, repo.path, sha, 1_000_000);
      expect(result.truncated).toBe(false);
      expect(result.omitted).toEqual([]);
      expect(result.patch).toContain('diff --git a/a.txt b/a.txt');
      expect(result.patch).toContain('diff --git a/b.txt b/b.txt');
      expect(result.patch).toContain('+changed');
      expect(result.patch).toContain('+new');
    } finally {
      await repo.dispose();
    }
  });

  it('omits the largest file(s) first when the byte cap is exceeded, keeping smaller files intact', async () => {
    const small = 'small file content\n';
    const large = `line\n`.repeat(2000); // much bigger than `small`'s patch
    const repo = await createRepo({
      commits: [
        { message: 'init', files: { 'small.txt': 'x\n', 'large.txt': 'x\n' } },
        { message: 'grow both', files: { 'small.txt': small, 'large.txt': large } },
      ],
    });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      // A cap big enough for small.txt's diff but not large.txt's.
      const result = await getCommitPatch(git, repo.path, sha, 500);
      expect(result.truncated).toBe(true);
      expect(result.omitted).toEqual(['large.txt']);
      expect(result.patch).toContain('diff --git a/small.txt b/small.txt');
      expect(result.patch).not.toContain('diff --git a/large.txt b/large.txt');
    } finally {
      await repo.dispose();
    }
  });

  it('diffs a merge commit against its first parent instead of printing a combined diff', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { 'shared.txt': 'base\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'feature change', files: { 'feature.txt': 'from feature\n' } });
      repo.git(['checkout', 'main']);
      repo.commit({ message: 'main change', files: { 'main.txt': 'from main\n' } });
      repo.git(['merge', '--no-ff', '-m', 'Merge feature', 'feature']);
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const result = await getCommitPatch(git, repo.path, sha, 1_000_000);
      // Against the first parent (main), only feature.txt is new; main.txt is already on that side.
      expect(result.patch).toContain('diff --git a/feature.txt b/feature.txt');
      expect(result.patch).not.toContain('diff --git a/main.txt b/main.txt');
    } finally {
      await repo.dispose();
    }
  });

  it('handles the root commit cleanly, diffing against nothing', async () => {
    const repo = await createRepo({ commits: [{ message: 'root', files: { 'a.txt': 'hello\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const result = await getCommitPatch(git, repo.path, sha, 1_000_000);
      expect(result.omitted).toEqual([]);
      expect(result.patch).toContain('+hello');
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('getRecentFileHistory', () => {
  it('returns up to `max` recent commits touching the path, most recent first, excluding the given commit', async () => {
    const repo = await createRepo({
      commits: [
        { message: 'add a', files: { 'a.txt': '1\n' } },
        { message: 'update a v2', files: { 'a.txt': '2\n' } },
        { message: 'update a v3', files: { 'a.txt': '3\n' } },
        { message: 'unrelated', files: { 'b.txt': '1\n' } },
        { message: 'update a v4', files: { 'a.txt': '4\n' } },
      ],
    });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const history = await getRecentFileHistory(git, repo.path, sha, 'a.txt', 5);
      expect(history).toHaveLength(3);
      expect(history[0]).toContain('update a v3');
      expect(history[history.length - 1]).toContain('add a');
    } finally {
      await repo.dispose();
    }
  });

  it('caps the result at `max` entries', async () => {
    const repo = await createRepo({
      commits: Array.from({ length: 6 }, (_, i) => ({ message: `a v${i}`, files: { 'a.txt': `${i}\n` } })).concat([{ message: 'final', files: { 'a.txt': 'final\n' } }]),
    });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      const history = await getRecentFileHistory(git, repo.path, sha, 'a.txt', 3);
      expect(history).toHaveLength(3);
    } finally {
      await repo.dispose();
    }
  });

  it('tolerates a root commit (no parent to start from) by returning an empty list', async () => {
    const repo = await createRepo({ commits: [{ message: 'root', files: { 'a.txt': '1\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      expect(await getRecentFileHistory(git, repo.path, sha, 'a.txt')).toEqual([]);
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('mergeBase', () => {
  it('finds the common ancestor of two diverged branches', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { 'a.txt': '1\n' } }] });
    try {
      const base = repo.git(['rev-parse', 'HEAD']).trim();
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'feature commit', files: { 'a.txt': '2\n' } });
      repo.git(['checkout', 'main']);
      repo.commit({ message: 'main commit', files: { 'b.txt': '1\n' } });
      const git = new GitClient(repo.tools());
      expect(await mergeBase(git, repo.path, 'main', 'feature')).toBe(base);
    } finally {
      await repo.dispose();
    }
  });

  it('returns the branch itself when one is a fast-forward ancestor of the other', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const base = repo.git(['rev-parse', 'HEAD']).trim();
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'feature commit', files: { 'a.txt': '2\n' } });
      const git = new GitClient(repo.tools());
      expect(await mergeBase(git, repo.path, 'main', 'feature')).toBe(base);
    } finally {
      await repo.dispose();
    }
  });

  it('returns null when a ref does not resolve', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      expect(await mergeBase(git, repo.path, 'main', 'does-not-exist')).toBeNull();
    } finally {
      await repo.dispose();
    }
  });
});
