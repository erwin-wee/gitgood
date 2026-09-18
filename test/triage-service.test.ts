import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTriageProgressEvent, PullRequest } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { GhClient } from '../src/main/gh/gh';
import type { RepositoryManager } from '../src/main/repo/manager';
import type { Store } from '../src/main/store';
import type { ToolLocator } from '../src/main/tools';

vi.mock('../src/main/ai/provider', () => ({ createBackend: vi.fn() }));

import { createBackend } from '../src/main/ai/provider';
import { TriageService } from '../src/main/ai/triage';

/**
 * Exercises `TriageService.run`'s batching and cancellation with a stubbed
 * backend (`createBackend` is mocked, matching how the pure-core tests in
 * triage.test.ts cover the deterministic rules and validation this service
 * relies on). No real gh/AI calls are made.
 */
function makePr(number: number): PullRequest {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/octo/repo/pull/${number}`,
    author: 'someone',
    headRefName: `feature-${number}`,
    baseRefName: 'main',
    headSha: `sha${number}`,
    headRepo: null,
    isCrossRepository: false,
    isDraft: false,
    state: 'OPEN',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    checks: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0, state: 'success' },
    reviewDecision: null,
    body: '',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [],
    assignees: [],
    reviewRequests: [],
    commitsCount: 1,
    filesChanged: [],
    reviewsCount: 0,
    latestReviews: [],
    commentsCount: 0,
  };
}

/** Extracts every `#N "` pull request number referenced in a built triage prompt, so the stub backend can answer for exactly the batch it was asked about without duplicating buildTriagePrompt's format. */
function numbersInPrompt(prompt: string): number[] {
  return [...prompt.matchAll(/#(\d+) "/g)].map((m) => Number(m[1]));
}

function makeService(gh: Partial<GhClient>, userDataDir: string): TriageService {
  const repos = { detectGitHub: vi.fn().mockResolvedValue({ host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' }), getByPath: () => null } as unknown as RepositoryManager;
  return new TriageService({} as unknown as Store, {} as unknown as ToolLocator, gh as GhClient, repos, userDataDir);
}

afterEach(() => vi.mocked(createBackend).mockReset());

describe('TriageService.run', () => {
  it('splits a 40 pull request run into three batches of at most 15 and reports progress after each', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-triage-svc-'));
    const prs = Array.from({ length: 40 }, (_, i) => makePr(i + 1));
    const complete = vi.fn(async (req: { prompt: string }) => ({
      json: { items: numbersInPrompt(req.prompt).map((n) => ({ number: n, summary: `Summary ${n}`, state: 'stale', reason: '', nextAction: 'none' })) },
      model: 'test-model',
    }));
    vi.mocked(createBackend).mockResolvedValue({ backend: { name: 'claude-cli', complete }, settings: { ...DEFAULT_SETTINGS.ai } });
    const gh = { prList: vi.fn().mockResolvedValue(prs), viewerLogin: vi.fn().mockResolvedValue('octocat'), prChecks: vi.fn().mockResolvedValue([]) };
    const service = makeService(gh, userDataDir);

    const reports: AiTriageProgressEvent[] = [];
    const cache = await service.run('/repo', prs.map((p) => p.number), (e) => reports.push(e));

    expect(complete).toHaveBeenCalledTimes(3);
    expect(Object.keys(cache).length).toBe(40);
    expect(reports.map((r) => r.done)).toEqual([0, 15, 30, 40]);
    expect(reports.every((r) => r.total === 40)).toBe(true);
  });

  it('keeps the first completed batch when cancelled before the second batch starts', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-triage-svc-'));
    const prs = Array.from({ length: 40 }, (_, i) => makePr(i + 1));
    let calls = 0;
    let service!: TriageService;
    const complete = vi.fn(async (req: { prompt: string }) => {
      calls++;
      const numbers = numbersInPrompt(req.prompt);
      if (calls === 1) service.cancel(); // simulates the user cancelling while the first batch is still in flight
      return { json: { items: numbers.map((n) => ({ number: n, summary: `Summary ${n}`, state: 'stale', reason: '', nextAction: 'none' })) }, model: 'test-model' };
    });
    vi.mocked(createBackend).mockResolvedValue({ backend: { name: 'claude-cli', complete }, settings: { ...DEFAULT_SETTINGS.ai } });
    const gh = { prList: vi.fn().mockResolvedValue(prs), viewerLogin: vi.fn().mockResolvedValue('octocat'), prChecks: vi.fn().mockResolvedValue([]) };
    service = makeService(gh, userDataDir);

    const cache = await service.run('/repo', prs.map((p) => p.number), () => {});

    expect(complete).toHaveBeenCalledTimes(1);
    expect(Object.keys(cache).map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

    // The cached (first) batch survives a second, empty run — cancellation never discards completed work.
    const again = await service.get('/repo');
    expect(Object.keys(again).length).toBe(15);
  });

  it('retries a pull request missing from its batch response once, individually', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-triage-svc-'));
    const prs = [makePr(1), makePr(2)];
    let calls = 0;
    const complete = vi.fn(async (req: { prompt: string }) => {
      calls++;
      const numbers = numbersInPrompt(req.prompt);
      // First call (the batch of both) "forgets" #2; the retry call (batch of just #2) answers it.
      const answered = calls === 1 ? numbers.filter((n) => n !== 2) : numbers;
      return { json: { items: answered.map((n) => ({ number: n, summary: `Summary ${n}`, state: 'stale', reason: '', nextAction: 'none' })) }, model: 'test-model' };
    });
    vi.mocked(createBackend).mockResolvedValue({ backend: { name: 'claude-cli', complete }, settings: { ...DEFAULT_SETTINGS.ai } });
    const gh = { prList: vi.fn().mockResolvedValue(prs), viewerLogin: vi.fn().mockResolvedValue('octocat'), prChecks: vi.fn().mockResolvedValue([]) };
    const service = makeService(gh, userDataDir);

    const cache = await service.run('/repo', [1, 2], () => {});

    expect(complete).toHaveBeenCalledTimes(2);
    expect(Object.keys(cache).map(Number).sort()).toEqual([1, 2]);
  });
});
