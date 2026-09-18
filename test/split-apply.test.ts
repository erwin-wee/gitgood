import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { SplitApplyProgress, SplitPlan } from '../src/shared/types';
import { GitClient } from '../src/main/git/git';
import { getWorkingDiff } from '../src/main/git/diff';
import { getStatus } from '../src/main/git/status';
import { SplitterService } from '../src/main/ai/splitter';
import { computeHunkId } from '../src/main/ai/splitter-core';
import type { AppSettings } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { Store } from '../src/main/store';
import { createRepo, hasGitSync, type TestRepo } from './helpers/repo';

function fakeStore(): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

/** Builds the SplitPlan a model would return for a fixture with two files, three hunks: file a.ts's two hunks go to commit 1, file b.ts's one hunk goes to commit 2. */
async function buildTwoCommitPlan(git: GitClient, repo: TestRepo): Promise<SplitPlan> {
  const status = await getStatus(git, repo.path);
  const fileA = status.files.find((f) => f.path === 'a.ts')!;
  const fileB = status.files.find((f) => f.path === 'b.ts')!;
  const diffA = await getWorkingDiff(git, repo.path, fileA, { hideWhitespace: false });
  const diffB = await getWorkingDiff(git, repo.path, fileB, { hideWhitespace: false });
  if (diffA.kind !== 'text' || diffB.kind !== 'text') throw new Error('expected text diffs');
  expect(diffA.hunks).toHaveLength(2);
  expect(diffB.hunks).toHaveLength(1);

  const idA0 = computeHunkId('a.ts', diffA.hunks[0]);
  const idA1 = computeHunkId('a.ts', diffA.hunks[1]);
  const idB0 = computeHunkId('b.ts', diffB.hunks[0]);

  const startSha = (await git.stdout(repo.path, ['rev-parse', 'HEAD'])).trim();
  const hashA = (await git.stdout(repo.path, ['hash-object', '--', 'a.ts'])).trim();
  const hashB = (await git.stdout(repo.path, ['hash-object', '--', 'b.ts'])).trim();

  return {
    id: 'plan-1',
    startSha,
    fileHashes: { 'a.ts': hashA, 'b.ts': hashB },
    hunks: [
      { id: idA0, path: 'a.ts', hunkIndex: 0, header: diffA.hunks[0].header, additions: 1, deletions: 0 },
      { id: idA1, path: 'a.ts', hunkIndex: 1, header: diffA.hunks[1].header, additions: 1, deletions: 0 },
      { id: idB0, path: 'b.ts', hunkIndex: 0, header: diffB.hunks[0].header, additions: 1, deletions: 0 },
    ],
    commits: [
      { id: 'c1', summary: 'Update a.ts', description: '', hunkIds: [idA0, idA1], wholeFiles: [], rationale: 'Both hunks touch a.ts.' },
      { id: 'c2', summary: 'Update b.ts', description: '', hunkIds: [idB0], wholeFiles: [], rationale: 'Unrelated change in b.ts.' },
    ],
    unassigned: [],
    warnings: [],
    model: 'test',
  };
}

describe.skipIf(!hasGitSync())('SplitterService.apply / undo (real git)', () => {
  it('turns three hunks across two files into two commits, in order', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n', 'b.ts': 'x1\nx2\nx3\n' } }] });
    try {
      await repo.write('a.ts', ['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');
      await repo.write('b.ts', 'x1\nx2 changed\nx3\n');
      const git = new GitClient(repo.tools());
      const splitter = new SplitterService(fakeStore(), repo.tools(), git);
      const plan = await buildTwoCommitPlan(git, repo);

      const events: SplitApplyProgress[] = [];
      const result = await splitter.apply(repo.path, plan, (e) => events.push(e));
      expect(result.shas).toHaveLength(2);
      expect(events.filter((e) => e.phase === 'done')).toHaveLength(2);

      const log = repo.git(['log', '--format=%s', '--reverse']).trim().split('\n');
      expect(log.slice(-2)).toEqual(['Update a.ts', 'Update b.ts']);
      expect(repo.git(['status', '--porcelain']).trim()).toBe('');
      expect(await readFile(`${repo.path}/a.ts`, 'utf8')).toBe(['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');
      expect(await readFile(`${repo.path}/b.ts`, 'utf8')).toBe('x1\nx2 changed\nx3\n');

      // Undo restores the pre-split HEAD, keeping the changes unstaged (nothing staged, both files differ from the restored HEAD).
      await splitter.undo(repo.path, plan.startSha);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(plan.startSha);
      expect(repo.git(['diff', '--cached', '--name-only']).trim()).toBe('');
      expect(
        repo
          .git(['diff', '--name-only', 'HEAD'])
          .trim()
          .split('\n')
          .sort(),
      ).toEqual(['a.ts', 'b.ts']);
      expect(await readFile(`${repo.path}/a.ts`, 'utf8')).toBe(['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');
    } finally {
      await repo.dispose();
    }
  });

  it('stops on a forced failure, leaving the first commit intact and the index clean', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n', 'b.ts': 'x1\nx2\nx3\n' } }] });
    try {
      await repo.write('a.ts', ['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');
      await repo.write('b.ts', 'x1\nx2 changed\nx3\n');
      const git = new GitClient(repo.tools());
      const splitter = new SplitterService(fakeStore(), repo.tools(), git);
      const plan = await buildTwoCommitPlan(git, repo);
      // Corrupt the second commit's only hunk id so its patch cannot be resolved against a fresh diff.
      plan.commits[1].hunkIds = ['does-not-exist'];

      const events: SplitApplyProgress[] = [];
      await expect(splitter.apply(repo.path, plan, (e) => events.push(e))).rejects.toThrow(/not part of this plan/);
      expect(events.some((e) => e.phase === 'error')).toBe(true);

      const log = repo.git(['log', '--format=%s']).trim().split('\n');
      expect(log[0]).toBe('Update a.ts');
      // Nothing staged for the failed commit; b.ts's pending change remains, unstaged, in the working tree.
      expect(repo.git(['diff', '--cached', '--name-only']).trim()).toBe('');
      expect(repo.git(['diff', '--name-only', 'HEAD']).trim()).toBe('b.ts');
      expect(await readFile(`${repo.path}/b.ts`, 'utf8')).toBe('x1\nx2 changed\nx3\n');
    } finally {
      await repo.dispose();
    }
  });

  it('refuses to apply when a file changed since the plan was made', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n', 'b.ts': 'x1\nx2\nx3\n' } }] });
    try {
      await repo.write('a.ts', ['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');
      await repo.write('b.ts', 'x1\nx2 changed\nx3\n');
      const git = new GitClient(repo.tools());
      const splitter = new SplitterService(fakeStore(), repo.tools(), git);
      const plan = await buildTwoCommitPlan(git, repo);

      await repo.write('a.ts', ['line1 changed AGAIN', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');

      await expect(splitter.apply(repo.path, plan, () => undefined)).rejects.toMatchObject({ kind: 'stale' });
      expect(repo.git(['log', '--format=%s']).trim()).toBe('init');
    } finally {
      await repo.dispose();
    }
  });

  it('undo refuses once startSha is no longer an ancestor of HEAD', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': 'a\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const splitter = new SplitterService(fakeStore(), repo.tools(), git);
      const startSha = repo.git(['rev-parse', 'HEAD']).trim();
      repo.commit({ message: 'another line', files: { 'a.ts': 'a\nb\n' } });
      // startSha IS an ancestor of the new HEAD here, so undo should succeed (the positive path).
      await splitter.undo(repo.path, startSha);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(startSha);

      // A sha that is not an ancestor of HEAD (never part of this repository's history) must be refused.
      const fakeSha = '0'.repeat(40);
      await expect(splitter.undo(repo.path, fakeSha)).rejects.toThrow(/no longer available/);
    } finally {
      await repo.dispose();
    }
  });

  it('undo refuses once the split commits have already been pushed to the upstream', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': 'a\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      const splitter = new SplitterService(fakeStore(), repo.tools(), git);
      const startSha = repo.git(['rev-parse', 'HEAD']).trim();
      repo.commit({ message: 'split commit', files: { 'a.ts': 'a\nb\n' } });
      // Configure a bare remote and push after the fact (createRepo's own `remote` option pushes at creation time, before this commit exists).
      const remotePath = `${repo.root}/origin.git`;
      repo.git(['init', '-q', '--bare', '-b', 'main', remotePath], repo.root);
      repo.git(['remote', 'add', 'origin', remotePath]);
      repo.git(['push', '-q', '-u', 'origin', 'main']);

      await expect(splitter.undo(repo.path, startSha)).rejects.toThrow(/already been pushed/);
      expect(repo.git(['rev-parse', 'HEAD']).trim()).not.toBe(startSha);
    } finally {
      await repo.dispose();
    }
  });
});
