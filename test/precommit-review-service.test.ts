import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createRepo, hasGitSync, type TestRepo } from './helpers/repo';

type TestRepoTools = TestRepo['tools'];

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

describe.skipIf(!hasGitSync())('ReviewService agent export (real git)', () => {
  const svc = (repoPath: string, userDataDir: string, tools: ReturnType<TestRepoTools>) => {
    const git = new GitClient(tools);
    const repos = { getByPath: () => null } as unknown as RepositoryManager;
    return new ReviewService(null as unknown as Store, tools, git, null as unknown as GhClient, repos, userDataDir);
  };

  it('writes latest.* and runs/* under .git/gitgood/review when a finished run is saved through dismiss', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-export-'));
    const service = svc(repo.path, userDataDir, repo.tools());
    await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, { findings: [finding({ id: 'f1', title: 'Use a constant' }), finding({ id: 'f2', line: 5, severity: 'blocker', title: 'Hard-coded token' })] }));

    await service.dismiss(repo.path, 'run-1', 'f1', true);

    const dir = join(repo.path, '.git', 'gitgood', 'review');
    const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'));
    expect(latest.version).toBe(1);
    expect(latest.runId).toBe('run-1');
    expect(latest.previousRunId).toBeNull();
    expect(latest.findings.map((f: { id: string; dismissed: boolean }) => [f.id, f.dismissed])).toEqual([['f2', false], ['f1', true]]);
    expect(latest.rerun.url).toBe(`gitgood://review/rerun?repo=${encodeURIComponent(repo.path)}`);
    expect(JSON.parse(await readFile(join(dir, 'runs', 'run-1.json'), 'utf8')).runId).toBe('run-1');
    const md = await readFile(join(dir, 'latest.md'), 'utf8');
    expect(md).toContain('Hard-coded token');
    expect(md).not.toContain('Use a constant');
    expect(await readFile(join(dir, 'runs', 'run-1.md'), 'utf8')).toBe(md);
    expect(await service.latest(repo.path)).toMatchObject({ id: 'run-1' });
    expect(await service.exportPath(repo.path, 'run-1')).toBe(join(dir, 'latest.md'));
  });

  it('chains previousRunId from the earlier export of the same target even after the store overwrote it', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-export-'));
    const service = svc(repo.path, userDataDir, repo.tools());
    await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, { id: 'run-1', findings: [finding()] }));
    await service.dismiss(repo.path, 'run-1', 'f1', false);
    // The pre-commit store keeps one file per repository, so seeding run-2 replaces run-1 there.
    await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, { id: 'run-2', findings: [finding()] }));
    await service.dismiss(repo.path, 'run-2', 'f1', false);

    const dir = join(repo.path, '.git', 'gitgood', 'review');
    const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'));
    expect(latest.runId).toBe('run-2');
    expect(latest.previousRunId).toBe('run-1');
    expect(await readFile(join(dir, 'runs', 'run-1.json'), 'utf8')).toContain('"runId": "run-1"');
    // Re-saving the same run keeps its chain instead of pointing at itself.
    await service.dismiss(repo.path, 'run-2', 'f1', true);
    expect(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).previousRunId).toBe('run-1');
  });

  it('does not let a dismissal on an older run replace latest.* with superseded findings', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-export-'));
    const service = svc(repo.path, userDataDir, repo.tools());
    const dir = join(repo.path, '.git', 'gitgood', 'review');

    // An old pre-commit run, then a newer pull request run for the same repository.
    await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, { id: 'old', startedAt: '2026-09-18T10:00:00.000Z', finishedAt: '2026-09-18T10:00:05.000Z', findings: [finding({ id: 'f1' })] }));
    await service.dismiss(repo.path, 'old', 'f1', false);
    const prRun = baseRun(repo.path, { id: 'new', startedAt: '2026-09-18T11:00:00.000Z', finishedAt: '2026-09-18T11:00:09.000Z', target: { kind: 'pr', number: 4, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), title: 'PR', url: 'https://x/4' }, findings: [finding({ id: 'p1', title: 'From the pull request' })] });
    await writeFile(join(userDataDir, 'reviews', stableHash(repo.path).replace(/[^A-Za-z0-9._-]+/g, '_'), 'pr-4-aaaaaaaaaaaa.json'), JSON.stringify(prRun, null, 2), 'utf8');
    await service.dismiss(repo.path, 'new', 'p1', false);
    expect(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).runId).toBe('new');

    // Dismissing on the older run refreshes its own files only.
    await service.dismiss(repo.path, 'old', 'f1', true);

    expect(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).runId).toBe('new');
    expect(await readFile(join(dir, 'latest.md'), 'utf8')).toContain('From the pull request');
    const older = JSON.parse(await readFile(join(dir, 'runs', 'old.json'), 'utf8'));
    expect(older.findings[0].dismissed).toBe(true);
    expect(older.previousRunId).toBeNull();
    // latest() orders by finish time, not start time.
    expect((await service.latest(repo.path))?.id).toBe('new');
    // A pull request export cannot be verified by a re-review, so it offers none.
    expect(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).rerun).toBeNull();
    // exportPath hands back the run's own copy when it is not the latest.
    expect(await service.exportPath(repo.path, 'old')).toBe(join(dir, 'runs', 'old.md'));
  });

  it('reports a failed export instead of handing back an older run\'s file', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-export-'));
    const service = svc(repo.path, userDataDir, repo.tools());
    await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, { findings: [finding()] }));
    await service.dismiss(repo.path, 'run-1', 'f1', false);
    const dir = join(repo.path, '.git', 'gitgood', 'review');
    expect(await service.exportPath(repo.path, 'run-1')).toBe(join(dir, 'latest.md'));

    // A file where the runs/ directory belongs makes every later write fail,
    // while the export from the successful run above is still on disk.
    await rm(join(dir, 'runs'), { recursive: true, force: true });
    await writeFile(join(dir, 'runs'), 'not a directory', 'utf8');

    await expect(service.exportPath(repo.path, 'run-1')).rejects.toThrow(/could not be written/i);
    // The stale file is still there; the point is that exportPath refused to name it.
    expect(existsSync(join(dir, 'latest.md'))).toBe(true);
  });

  it('keeps at most five exported runs, newest first', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-export-'));
    const service = svc(repo.path, userDataDir, repo.tools());
    for (let i = 1; i <= 7; i++) {
      await seedWorktreeRun(userDataDir, repo.path, baseRun(repo.path, { id: `run-${i}`, startedAt: `2026-09-18T10:0${i}:00.000Z`, finishedAt: `2026-09-18T10:0${i}:05.000Z`, findings: [finding()] }));
      await service.dismiss(repo.path, `run-${i}`, 'f1', false);
    }
    const runsDir = join(repo.path, '.git', 'gitgood', 'review', 'runs');
    const files = (await readdir(runsDir)).filter((f) => f.endsWith('.json')).sort();
    expect(files).toHaveLength(5);
    expect(files).toContain('run-7.json');
    expect(files).not.toContain('run-1.json');
    // The markdown twin of a pruned run goes with it.
    expect(existsSync(join(runsDir, 'run-1.md'))).toBe(false);
    expect(JSON.parse(await readFile(join(runsDir, 'run-7.json'), 'utf8')).previousRunId).toBe('run-6');
  });

  it('exports into a linked worktree\'s own git directory', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const wtPath = join(repo.root, 'wt');
    repo.git(['worktree', 'add', '-q', '-b', 'wt', wtPath]);
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-export-'));
    const service = svc(wtPath, userDataDir, repo.tools());
    await seedWorktreeRun(userDataDir, wtPath, baseRun(wtPath, { findings: [finding()] }));

    await service.dismiss(wtPath, 'run-1', 'f1', false);

    const gitDir = repo.git(['rev-parse', '--git-dir'], wtPath).trim();
    const dir = join(gitDir.startsWith('/') || /^[A-Za-z]:/.test(gitDir) ? gitDir : join(wtPath, gitDir), 'gitgood', 'review');
    expect(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).repoPath).toBe(wtPath);
    await expect(readFile(join(repo.path, '.git', 'gitgood', 'review', 'latest.json'), 'utf8')).rejects.toThrow();
  });
});
