import { describe, expect, it, vi } from 'vitest';
import { AiError } from '../src/main/ai/backends';
import { guardAiHandlers } from '../src/main/ai/repo-guard';

function build() {
  const handlers = {
    'ai.review.start': vi.fn(async (_repo: string) => 'started'),
    'ai.explainError': vi.fn(async (_repo: string | null) => 'explained'),
    'ai.cancel': vi.fn(async () => undefined),
    'ai.split.undo': vi.fn(async (_repo: string) => 'undone'),
    'repo.status': vi.fn(async (_repo: string) => 'status'),
  };
  guardAiHandlers(handlers as never, async (repoPath) => (repoPath === '/off' ? 'AI is off here' : null));
  return handlers;
}

describe('guardAiHandlers', () => {
  it('refuses ai.* calls for an opted-out repository before the handler runs', async () => {
    const inner = vi.fn(async () => 'started');
    const handlers = { 'ai.review.start': inner };
    guardAiHandlers(handlers as never, async (p) => (p === '/off' ? 'AI is off here' : null));
    await expect(handlers['ai.review.start']('/off' as never)).rejects.toThrow(AiError);
    expect(inner).not.toHaveBeenCalled();
    await expect(handlers['ai.review.start']('/on' as never)).resolves.toBe('started');
  });

  it('leaves non-ai methods, argument-less calls, null repo paths and rollbacks alone', async () => {
    const h = build() as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(h['repo.status']('/off')).resolves.toBe('status');
    await expect(h['ai.cancel']()).resolves.toBeUndefined();
    await expect(h['ai.explainError'](null)).resolves.toBe('explained');
    await expect(h['ai.split.undo']('/off')).resolves.toBe('undone');
  });

  it('guards methods added later by prefix, not by a list', async () => {
    const h = { 'ai.somethingNew': async (_p: string) => 'ok' };
    guardAiHandlers(h as never, async () => 'blocked');
    await expect(h['ai.somethingNew']('/x')).rejects.toThrow('blocked');
  });
});
