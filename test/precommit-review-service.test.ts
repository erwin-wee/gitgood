import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewRun } from '../src/shared/types';
import { GitClient } from '../src/main/git/git';
import { ReviewService } from '../src/main/ai/review';
import { stableHash } from '../src/main/ai/review-core';
import type { GhClient } from '../src/main/gh/gh';
import type { RepositoryManager } from '../src/main/repo/manager';
import type { Store } from '../src/main/store';
import { createRepo, hasGitSync } from './helpers/repo';

/**
 * Exercises `ReviewService.worktreeStale` and `applySuggestion` end to end
 * against a real temp repository: `startWorktree` itself needs a configured
 * AI backend, so these two lower-level pieces (the file-content-hash
 * staleness check and the hash-guarded write) are tested directly by seeding
 * a run file on disk in the exact shape `saveRun` would produce, using only
 * the real `GitClient` (no Store/backend/gh involved in either method).
 */
async function seedWorktreeRun(userDataDir: string, repoPath: string, run: ReviewRun): Promise<void> {
  const dir = join(userDataDir, 'reviews', stableHash(repoPath).replace(/[^A-Za-z0-9._-]+/g, '_'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'worktree.json'), JSON.stringify(run, null, 2), 'utf8');
}

function baseRun(repoPath: string, overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-1',
    repoPath,
    target: { kind: 'worktree', paths: [], partialPaths: [], indexSha: '' },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: 'test',
    provider: 'claude-cli',
    effort: 'high',
    strictness: 'balanced',
    summary: '',
    verdict: null,
    findings: [],
    files: [],
    droppedInvalid: 0,
    error: null,
    cancelled: false,
    ownPullRequest: false,
    commitMessageMatches: null,
    commitMessageNote: '',
    ...overrides,
  };
}

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'f1',
  path: 'src/app.ts',
  line: 2,
  endLine: 2,
  severity: 'warning',
  category: 'readability',
  title: 'Use a constant',
  detail: 'Avoid the magic number.',
  suggestion: 'const b = 20;',
  confidence: 'high',
  dismissed: false,
  ...over,
});

describe.skipIf(!hasGitSync())('ReviewService pre-commit worktree helpers (real git)', () => {
  it('worktreeStale reports no stale paths until the file is edited, then reports it', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-svc-'));
    const git = new GitClient(repo.tools());
    const repos = { getByPath: () => null } as unknown as RepositoryManager;
    const service = new ReviewService(null as unknown as Store, repo.tools(), git, null as unknown as GhClient, repos, userDataDir);

    const hash = repo.git(['hash-object', 'src/app.ts']).trim();
    await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, {
      files: [{ file: { path: 'src/app.ts', oldPath: null, status: 'modified', additions: null, deletions: null, binary: false, lfs: false }, status: 'reviewed', reason: null, hash }],
    }));

    expect(await service.worktreeStale(repo.path, 'run-1')).toEqual([]);

    await repo.write('src/app.ts', 'export const a = 2; // edited\n');
    expect(await service.worktreeStale(repo.path, 'run-1')).toEqual(['src/app.ts']);

    await repo.dispose();
  });

  it('applySuggestion refuses when the file changed since the review, and succeeds with a CRLF round trip', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'line one\r\nline two\r\nline three\r\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-svc-'));
    const git = new GitClient(repo.tools());
    const repos = { getByPath: () => null } as unknown as RepositoryManager;
    const service = new ReviewService(null as unknown as Store, repo.tools(), git, null as unknown as GhClient, repos, userDataDir);

    const hashAtReview = repo.git(['hash-object', 'src/app.ts']).trim();
    const run = baseRun(repo.path, {
      files: [{ file: { path: 'src/app.ts', oldPath: null, status: 'modified', additions: null, deletions: null, binary: false, lfs: false }, status: 'reviewed', reason: null, hash: hashAtReview }],
      findings: [finding({ line: 2, endLine: 2, suggestion: 'LINE TWO' })],
    });
    await seedWorktreeRun(userDataDir, repo.path, run);

    // Edit the file after the review ran: applying must be refused.
    await repo.write('src/app.ts', 'line one\r\nline two\r\nline three\r\nline four\r\n');
    await expect(service.applySuggestion(repo.path, 'run-1', 'f1')).rejects.toThrow(/changed since the review/);
    expect(await readFile(join(repo.path, 'src/app.ts'), 'utf8')).toBe('line one\r\nline two\r\nline three\r\nline four\r\n');

    // Restore the file to what it was when the review ran, then apply: the suggestion lands and CRLF is preserved.
    await repo.write('src/app.ts', 'line one\r\nline two\r\nline three\r\n');
    await service.applySuggestion(repo.path, 'run-1', 'f1');
    expect(await readFile(join(repo.path, 'src/app.ts'), 'utf8')).toBe('line one\r\nLINE TWO\r\nline three\r\n');

    await repo.dispose();
  });

  it('applySuggestion refuses for a partially selected file', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'a\nb\nc\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-svc-'));
    const git = new GitClient(repo.tools());
    const repos = { getByPath: () => null } as unknown as RepositoryManager;
    const service = new ReviewService(null as unknown as Store, repo.tools(), git, null as unknown as GhClient, repos, userDataDir);

    const hash = repo.git(['hash-object', 'src/app.ts']).trim();
    const run = baseRun(repo.path, {
      target: { kind: 'worktree', paths: ['src/app.ts'], partialPaths: ['src/app.ts'], indexSha: '' },
      files: [{ file: { path: 'src/app.ts', oldPath: null, status: 'modified', additions: null, deletions: null, binary: false, lfs: false }, status: 'reviewed', reason: null, hash }],
      findings: [finding()],
    });
    await seedWorktreeRun(userDataDir, repo.path, run);

    await expect(service.applySuggestion(repo.path, 'run-1', 'f1')).rejects.toThrow(/partially selected/);
    await repo.dispose();
  });
});
