import { describe, expect, it } from 'vitest';
import type { PullRequest, PullRequestChecksSummary } from '../src/shared/types';
import { buildTriageEntry, classifyTriageState, downgradeNextAction, evictTriageCache, isTriageFresh, splitBatches, validateTriageBatch } from '../src/main/ai/triage-core';
import { buildTriagePrompt, TRIAGE_SCHEMA, type TriagePromptPr } from '../src/main/ai/prompts';

const NOW = Date.parse('2026-06-01T00:00:00Z');

const checks = (state: PullRequestChecksSummary['state']): PullRequestChecksSummary => ({ total: 3, passed: state === 'success' ? 3 : 1, failed: state === 'failure' ? 2 : 0, pending: state === 'pending' ? 2 : 0, skipped: 0, state });

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Add retry logic',
    url: 'https://github.com/octo/repo/pull/1',
    author: 'octocat',
    headRefName: 'feature',
    baseRefName: 'main',
    headSha: 'abc123',
    headRepo: null,
    isCrossRepository: false,
    isDraft: false,
    state: 'OPEN',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-30T00:00:00Z',
    checks: checks('success'),
    reviewDecision: null,
    body: '',
    additions: 10,
    deletions: 2,
    changedFiles: 2,
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
    ...overrides,
  };
}

describe('classifyTriageState', () => {
  it('classifies a draft pull request as draft regardless of anything else', () => {
    expect(classifyTriageState(pr({ isDraft: true, mergeable: 'CONFLICTING' }), 'octocat', NOW)).toBe('draft');
  });

  it('classifies conflicting mergeability as conflicts', () => {
    expect(classifyTriageState(pr({ mergeable: 'CONFLICTING' }), 'someone-else', NOW)).toBe('conflicts');
  });

  it('classifies a failing-checks own pull request as waiting on the author', () => {
    expect(classifyTriageState(pr({ author: 'octocat', checks: checks('failure') }), 'octocat', NOW)).toBe('waiting-on-author');
  });

  it('does not apply the own-PR-failing-checks rule to someone else\'s pull request', () => {
    expect(classifyTriageState(pr({ author: 'someone-else', checks: checks('failure') }), 'octocat', NOW)).toBeNull();
  });

  it('classifies an explicit review request for the signed-in user as waiting on you', () => {
    expect(classifyTriageState(pr({ reviewRequests: ['Octocat'] }), 'octocat', NOW)).toBe('waiting-on-you');
  });

  it('classifies 14+ days of inactivity as stale', () => {
    const stale = pr({ updatedAt: new Date(NOW - 15 * 24 * 60 * 60 * 1000).toISOString() });
    expect(classifyTriageState(stale, 'octocat', NOW)).toBe('stale');
  });

  it('leaves recent, non-decisive pull requests to the model (returns null)', () => {
    expect(classifyTriageState(pr(), 'someone-else', NOW)).toBeNull();
  });

  it('applies rules in priority order: draft beats conflicts beats own-failing-checks beats review-request beats stale', () => {
    const everything = pr({ isDraft: true, mergeable: 'CONFLICTING', author: 'octocat', checks: checks('failure'), reviewRequests: ['octocat'], updatedAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString() });
    expect(classifyTriageState(everything, 'octocat', NOW)).toBe('draft');
    expect(classifyTriageState({ ...everything, isDraft: false }, 'octocat', NOW)).toBe('conflicts');
    expect(classifyTriageState({ ...everything, isDraft: false, mergeable: 'MERGEABLE' }, 'octocat', NOW)).toBe('waiting-on-author');
    expect(classifyTriageState({ ...everything, isDraft: false, mergeable: 'MERGEABLE', checks: checks('success') }, 'octocat', NOW)).toBe('waiting-on-you');
    expect(classifyTriageState({ ...everything, isDraft: false, mergeable: 'MERGEABLE', checks: checks('success'), reviewRequests: [] }, 'octocat', NOW)).toBe('stale');
  });
});

describe('downgradeNextAction', () => {
  it('keeps merge when the pull request is mergeable, checks pass and it is approved', () => {
    expect(downgradeNextAction('merge', pr({ mergeable: 'MERGEABLE', checks: checks('success'), reviewDecision: 'APPROVED' }))).toBe('merge');
  });

  it('downgrades merge to none when checks are failing', () => {
    expect(downgradeNextAction('merge', pr({ mergeable: 'MERGEABLE', checks: checks('failure'), reviewDecision: 'APPROVED' }))).toBe('none');
  });

  it('downgrades merge to none when not approved', () => {
    expect(downgradeNextAction('merge', pr({ mergeable: 'MERGEABLE', checks: checks('success'), reviewDecision: null }))).toBe('none');
  });

  it('downgrades merge to none when conflicting', () => {
    expect(downgradeNextAction('merge', pr({ mergeable: 'CONFLICTING', checks: checks('success'), reviewDecision: 'APPROVED' }))).toBe('none');
  });

  it('leaves other next actions untouched', () => {
    expect(downgradeNextAction('review', pr())).toBe('review');
    expect(downgradeNextAction('none', pr())).toBe('none');
  });
});

describe('buildTriageEntry / validateTriageBatch', () => {
  const prs = [pr({ number: 1 }), pr({ number: 2, isDraft: true })];
  const byNumber = new Map(prs.map((p) => [p.number, p]));

  it('builds an entry from a well-formed item, applying caps', () => {
    const longSummary = 'x'.repeat(200);
    const longReason = 'y'.repeat(300);
    const entry = buildTriageEntry({ number: 1, summary: longSummary, state: 'ready-to-merge', reason: longReason, nextAction: 'merge' }, byNumber, 'someone-else', NOW, 'claude-test', '2026-06-01T00:00:00Z');
    expect(entry).not.toBeNull();
    expect(entry!.summary.length).toBe(140);
    expect(entry!.reason.length).toBe(200);
    expect(entry!.number).toBe(1);
    expect(entry!.updatedAt).toBe(prs[0].updatedAt);
  });

  it('overrides the model state with the deterministic draft rule', () => {
    const entry = buildTriageEntry({ number: 2, summary: 'Looks ready', state: 'ready-to-merge', reason: 'All good', nextAction: 'merge' }, byNumber, 'someone-else', NOW, 'claude-test', '2026-06-01T00:00:00Z');
    expect(entry!.state).toBe('draft');
  });

  it('downgrades a merge next action that does not survive the rules', () => {
    const entry = buildTriageEntry({ number: 1, summary: 'Ready', state: 'ready-to-merge', reason: 'ok', nextAction: 'merge' }, byNumber, 'someone-else', NOW, 'claude-test', '2026-06-01T00:00:00Z');
    // pr #1 defaults to reviewDecision null, so merge should be downgraded.
    expect(entry!.nextAction).toBe('none');
  });

  it('drops an item naming a pull request outside the batch', () => {
    expect(buildTriageEntry({ number: 999, summary: 'x', state: 'stale', reason: '', nextAction: 'none' }, byNumber, null, NOW, 'm', 'now')).toBeNull();
  });

  it('drops an item with an invalid state or missing summary', () => {
    expect(buildTriageEntry({ number: 1, summary: '', state: 'stale', reason: '', nextAction: 'none' }, byNumber, null, NOW, 'm', 'now')).toBeNull();
    expect(buildTriageEntry({ number: 1, summary: 'x', state: 'bogus', reason: '', nextAction: 'none' }, byNumber, null, NOW, 'm', 'now')).toBeNull();
  });

  it('reports numbers missing from the batch response', () => {
    const result = validateTriageBatch({ items: [{ number: 1, summary: 'ok', state: 'stale', reason: '', nextAction: 'none' }] }, prs, null, NOW, 'm', 'now');
    expect(result.entries.map((e) => e.number)).toEqual([1]);
    expect(result.missingNumbers).toEqual([2]);
  });

  it('tolerates a malformed response (non-array items) by reporting everything missing', () => {
    const result = validateTriageBatch({}, prs, null, NOW, 'm', 'now');
    expect(result.entries).toEqual([]);
    expect(result.missingNumbers).toEqual([1, 2]);
  });
});

describe('splitBatches', () => {
  it('splits into chunks of the given size, preserving order', () => {
    expect(splitBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('defaults to a batch size of 15', () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const batches = splitBatches(items);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(15);
    expect(batches[1].length).toBe(15);
    expect(batches[2].length).toBe(10);
  });

  it('returns an empty array for no items', () => {
    expect(splitBatches([])).toEqual([]);
  });
});

describe('evictTriageCache', () => {
  function entry(generatedAt: string) {
    return { number: 1, updatedAt: 'u', headSha: null, summary: 's', state: 'stale' as const, reason: '', nextAction: 'none' as const, model: 'm', generatedAt };
  }

  it('evicts entries for pull requests no longer open (closed or merged)', () => {
    const cache = { 1: entry(new Date(NOW).toISOString()), 2: entry(new Date(NOW).toISOString()) };
    const result = evictTriageCache(cache, new Set([1]), NOW);
    expect(Object.keys(result)).toEqual(['1']);
  });

  it('evicts entries older than 30 days', () => {
    const old = entry(new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString());
    const cache = { 1: old };
    const result = evictTriageCache(cache, new Set([1]), NOW);
    expect(Object.keys(result)).toEqual([]);
  });

  it('keeps entries within 30 days for still-open pull requests', () => {
    const recent = entry(new Date(NOW - 29 * 24 * 60 * 60 * 1000).toISOString());
    const cache = { 1: recent };
    const result = evictTriageCache(cache, new Set([1]), NOW);
    expect(Object.keys(result)).toEqual(['1']);
  });
});

describe('buildTriagePrompt', () => {
  function promptPr(overrides: Partial<TriagePromptPr> = {}): TriagePromptPr {
    return {
      number: 1,
      title: 'Add retry logic',
      body: 'short body',
      author: 'octocat',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feature',
      headRepo: null,
      labels: [],
      reviewDecision: null,
      reviewRequests: [],
      latestReviews: [],
      checksSummary: '3/3 passed',
      failingChecks: [],
      mergeable: 'MERGEABLE',
      updatedAt: '2026-05-30T00:00:00Z',
      ageDays: 2,
      fileStats: null,
      ...overrides,
    };
  }

  it('caps the pull request body at 1,500 characters in the built prompt', () => {
    const long = 'x'.repeat(3000);
    const prompt = buildTriagePrompt([promptPr({ body: long })], 'octocat');
    expect(prompt).toContain('x'.repeat(1500));
    expect(prompt).not.toContain('x'.repeat(1501));
  });

  it('omits file statistics entirely when the diff-stat setting is off (fileStats null)', () => {
    const prompt = buildTriagePrompt([promptPr({ fileStats: null })], 'octocat');
    expect(prompt).not.toContain('Files changed');
    expect(prompt).not.toContain('additions');
  });

  it('includes per-file statistics when provided', () => {
    const prompt = buildTriagePrompt([promptPr({ fileStats: [{ path: 'src/a.ts', additions: 3, deletions: 1 }] })], 'octocat');
    expect(prompt).toContain('Files changed');
    expect(prompt).toContain('src/a.ts (+3/-1)');
  });

  it('names the signed-in user so the model can reason about "waiting on you"', () => {
    expect(buildTriagePrompt([promptPr()], 'octocat')).toContain('Signed-in user: octocat.');
    expect(buildTriagePrompt([promptPr()], null)).toContain('Signed-in user: (not signed in).');
  });

  it('the schema requires every field and forbids extras', () => {
    const item = TRIAGE_SCHEMA.properties.items.items;
    expect(item.required).toEqual(['number', 'summary', 'state', 'reason', 'nextAction']);
    expect(item.additionalProperties).toBe(false);
  });
});

describe('isTriageFresh', () => {
  it('is fresh when the cached updatedAt matches the pull request', () => {
    const p = pr({ updatedAt: '2026-05-30T00:00:00Z' });
    expect(isTriageFresh({ number: 1, updatedAt: '2026-05-30T00:00:00Z', headSha: null, summary: 's', state: 'stale', reason: '', nextAction: 'none', model: 'm', generatedAt: 'now' }, p)).toBe(true);
  });

  it('is stale when the pull request has a newer updatedAt', () => {
    const p = pr({ updatedAt: '2026-06-01T00:00:00Z' });
    expect(isTriageFresh({ number: 1, updatedAt: '2026-05-30T00:00:00Z', headSha: null, summary: 's', state: 'stale', reason: '', nextAction: 'none', model: 'm', generatedAt: 'now' }, p)).toBe(false);
  });

  it('is stale (false) when there is no cache entry', () => {
    expect(isTriageFresh(undefined, pr())).toBe(false);
  });
});
