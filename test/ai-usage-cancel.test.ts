import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnthropicParams } from '../src/main/ai/backends';
import { addUsage, configureUsage, readUsage, recordUsage, type UsageLog } from '../src/main/ai/usage';
import { writeRepoFile } from '../src/main/repo/paths';
import { createHandlers, type HandlerDeps } from '../src/main/core/handlers';

const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0, costUsd: number | null = null) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costUsd });

describe('addUsage', () => {
  it('merges per month and feature, and keeps cost null until a backend reports one', () => {
    let log: UsageLog = {};
    log = addUsage(log, '2026-10', 'review', u(100, 10, 50, 5));
    log = addUsage(log, '2026-10', 'review', u(200, 20, 0, 0));
    log = addUsage(log, '2026-10', 'explain', u(1, 1));
    log = addUsage(log, '2026-09', 'review', u(7, 7, 0, 0, 0.5));
    expect(log['2026-10']?.review).toEqual({ requests: 2, inputTokens: 300, outputTokens: 30, cacheReadTokens: 50, cacheWriteTokens: 5, costUsd: null });
    expect(log['2026-10']?.explain?.requests).toBe(1);
    expect(log['2026-09']?.review?.costUsd).toBe(0.5);
    log = addUsage(log, '2026-09', 'review', u(1, 1)); // a later request without a reported cost does not erase the sum
    expect(log['2026-09']?.review).toMatchObject({ requests: 2, costUsd: 0.5 });
  });
});

describe('usage file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-usage-'));
    configureUsage(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('accumulates across calls, reports this and last month, and ignores requests without usage', async () => {
    const now = new Date(2026, 0, 15);
    await recordUsage('review', u(10, 1), new Date(2025, 11, 31));
    await recordUsage('review', u(20, 2), now);
    await recordUsage('review', u(5, 5), now);
    await recordUsage('triage', undefined, now);
    const [thisMonth, lastMonth] = await readUsage(now);
    expect(thisMonth).toMatchObject({ month: '2026-01', features: { review: { requests: 2, inputTokens: 25 } } });
    expect(Object.keys(thisMonth.features)).toEqual(['review']);
    expect(lastMonth).toMatchObject({ month: '2025-12', features: { review: { requests: 1, inputTokens: 10 } } });
    expect(JSON.parse(await readFile(join(dir, 'ai-usage.json'), 'utf8'))['2026-01'].review.requests).toBe(2);
  });
});

describe('buildAnthropicParams', () => {
  const base = { system: 'sys', prompt: 'file part', schema: {}, model: 'claude-sonnet-4-5', effort: 'medium' as const };

  it('marks the system prompt for caching', () => {
    const p = buildAnthropicParams(base);
    expect(p.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(p.messages[0].content).toBe('file part');
  });

  it('sends the shared context as a cached leading block before the per-file part, keeping the text identical', () => {
    const p = buildAnthropicParams({ ...base, sharedPrompt: 'PR context' });
    const content = p.messages[0].content as { text: string; cache_control?: unknown }[];
    expect(content.map((b) => b.text).join('')).toBe('PR context\n\nfile part');
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(content[1].cache_control).toBeUndefined();
  });
});

describe('ai.cancel', () => {
  const services = () => ({
    resolver: { cancel: vi.fn() },
    review: { cancel: vi.fn() },
    splitter: { cancel: vi.fn() },
    triage: { cancel: vi.fn() },
    prDraft: { cancel: vi.fn() },
    rebasePlan: { cancel: vi.fn() },
    releaseNotes: { cancel: vi.fn() },
    explain: { cancel: vi.fn() },
    errorExplain: { cancel: vi.fn() },
    nlPalette: { cancel: vi.fn(), setDispatcher: () => undefined },
  });

  it('cancels only the named feature', async () => {
    const deps = services();
    const { handlers } = createHandlers(deps as unknown as HandlerDeps);
    await handlers['ai.cancel']('triage');
    await handlers['ai.cancel']('commitMessage');
    expect(deps.triage.cancel).toHaveBeenCalledTimes(1);
    expect(deps.resolver.cancel).toHaveBeenCalledWith('commitMessage');
    expect(deps.review.cancel).not.toHaveBeenCalled();
    expect(deps.explain.cancel).not.toHaveBeenCalled();
    expect(deps.nlPalette.cancel).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('writeRepoFile', () => {
  it('writes inside the repo but never through a symlink that points outside', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gg-write-'));
    try {
      const repo = join(dir, 'repo');
      const outside = join(dir, 'outside.txt');
      await mkdir(join(repo, 'sub'), { recursive: true });
      await writeFile(outside, 'secret');
      await symlink(outside, join(repo, 'link.txt'));
      await symlink(dir, join(repo, 'dirlink'));
      await writeRepoFile(repo, 'sub/a.txt', 'ok');
      expect(await readFile(join(repo, 'sub/a.txt'), 'utf8')).toBe('ok');
      await expect(writeRepoFile(repo, 'link.txt', 'pwn')).rejects.toThrow(/symbolic link/);
      await expect(writeRepoFile(repo, 'dirlink/new.txt', 'pwn')).rejects.toThrow();
      expect(await readFile(outside, 'utf8')).toBe('secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('repo.readFile / repo.writeFile handlers refuse a symlinked leaf', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gg-rw-'));
    try {
      const repo = join(dir, 'repo');
      await mkdir(repo, { recursive: true });
      await writeFile(join(dir, 'outside.txt'), 'secret');
      await symlink(join(dir, 'outside.txt'), join(repo, 'link.txt'));
      await writeFile(join(repo, 'plain.txt'), 'hi');
      const { handlers } = createHandlers({ nlPalette: { setDispatcher: () => undefined } } as unknown as HandlerDeps);
      expect(await handlers['repo.readFile'](repo, 'plain.txt')).toBe('hi');
      await expect(handlers['repo.readFile'](repo, 'link.txt')).rejects.toThrow();
      await expect(handlers['repo.writeFile'](repo, 'link.txt', 'pwn')).rejects.toThrow(/symbolic link/);
      expect(await readFile(join(dir, 'outside.txt'), 'utf8')).toBe('secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
