import { describe, expect, it } from 'vitest';
import { windowClientId, windowsFor } from '../src/main/core/event-routing';

const windows = [1, 2, 3].map((id) => ({ id, clientId: windowClientId(id) }));
const nobody = () => [];

describe('windowClientId', () => {
  it('gives every window its own, stable client id', () => {
    const ids = windows.map((w) => w.clientId);
    expect(new Set(ids).size).toBe(3);
    expect(windowClientId(2)).toBe(ids[1]);
    expect(ids).not.toContain(''); // '' is the "no calling window" context
  });
});

describe('windowsFor', () => {
  it('sends a calling window its own progress and AI events only', () => {
    for (const event of ['progress', 'ai.progress', 'ai.review.progress', 'ai.split.progress', 'gh.auth.code'] as const) {
      expect(windowsFor(event, {}, windowClientId(2), windows, nobody).map((w) => w.id)).toEqual([2]);
    }
  });

  it('falls back to every window when a caller event has no calling window', () => {
    expect(windowsFor('progress', {}, '', windows, nobody)).toHaveLength(3);
  });

  it('sends repo.changed to the windows that have that repository open, whoever caused it', () => {
    const watchers = (repoPath: string) => (repoPath === '/repo/a' ? [windowClientId(1), windowClientId(3)] : []);
    expect(windowsFor('repo.changed', { repoPath: '/repo/a', reason: 'both' }, windowClientId(2), windows, watchers).map((w) => w.id)).toEqual([1, 3]);
    expect(windowsFor('repo.changed', { repoPath: '/repo/b', reason: 'both' }, '', windows, watchers)).toEqual([]);
  });

  it('broadcasts app-wide events to every window regardless of the caller', () => {
    for (const event of ['repos.changed', 'settings.changed', 'tools.changed', 'gh.inbox.changed', 'app.update.changed', 'theme.changed', 'repos.scanProgress'] as const) {
      expect(windowsFor(event, {}, windowClientId(2), windows, nobody)).toHaveLength(3);
    }
  });

  it('ignores clients that are not a window', () => {
    const watchers = () => ['not-a-window'];
    expect(windowsFor('repo.changed', { repoPath: '/x' }, '', windows, watchers)).toEqual([]);
  });
});
