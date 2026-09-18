import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, GitHubAccount, InboxItem } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { GitError } from '../src/main/git/git';
import { IDLE_PAUSE_MS, InboxPoller, type InboxPollerDeps } from '../src/main/gh/inbox-poller';
import type { GhClient } from '../src/main/gh/gh';
import type { Store, InboxCacheFile } from '../src/main/store';

const ACCOUNT: GitHubAccount = { login: 'octocat', name: null, avatarUrl: null, host: 'github.com', scopes: ['repo', 'notifications'], protocol: 'https' };

/** Flushes pending microtasks (the poller's internal `await`s) without depending on real wall-clock time. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface ScheduledCall {
  fn: () => void;
  ms: number;
}

/** A fully fake clock/timer pair: `now()` only advances when the test tells it to, and every scheduled callback is invoked explicitly, so the scheduler can be driven deterministically. */
class FakeClock {
  calls: ScheduledCall[] = [];

  constructor(public time = 0) {}

  now = (): number => this.time;
  setTimer = (fn: () => void, ms: number): ScheduledCall => {
    const call = { fn, ms };
    this.calls.push(call);
    return call;
  };
  clearTimer = (): void => {};
  advance(ms: number): void {
    this.time += ms;
  }
  /** Invokes the most recently scheduled callback and waits for its async work to settle. */
  async fireLatest(): Promise<void> {
    const call = this.calls[this.calls.length - 1];
    call.fn();
    await flush();
  }
}

function fakeStore(settings: Partial<AppSettings> = {}): { store: Store; cache: InboxCacheFile } {
  const cache: InboxCacheFile = { items: [], lastModified: null, lastPolledAt: null };
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...settings };
  const store = {
    getSettings: () => merged,
    getInboxCache: () => cache,
    setInboxCache: (next: InboxCacheFile) => {
      cache.items = next.items;
      cache.lastModified = next.lastModified;
      cache.lastPolledAt = next.lastPolledAt;
    },
  };
  return { store: store as unknown as Store, cache };
}

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: '1',
    threadId: '1',
    repo: { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' },
    localRepoId: null,
    subject: { type: 'PullRequest', title: 'Add feature', url: 'https://github.com/octo/repo/pull/1', number: 1 },
    reason: 'review_requested',
    unread: true,
    updatedAt: '2026-01-01T00:00:00Z',
    lastReadAt: null,
    ...overrides,
  };
}

function makePoller(opts: {
  settings?: Partial<AppSettings>;
  account?: GitHubAccount | null;
  gh?: Partial<GhClient>;
  onChange?: (s: unknown) => void;
  onNewItems?: (items: InboxItem[]) => void;
  startTime?: number;
}) {
  const clock = new FakeClock(opts.startTime ?? 0);
  const { store, cache } = fakeStore(opts.settings);
  const gh = {
    notificationsPoll: vi.fn().mockResolvedValue({ notModified: true, pollIntervalSeconds: null }),
    markThreadRead: vi.fn().mockResolvedValue(undefined),
    markAllNotificationsRead: vi.fn().mockResolvedValue(undefined),
    unsubscribeThread: vi.fn().mockResolvedValue(undefined),
    ...opts.gh,
  } as unknown as GhClient;
  const onChange = opts.onChange ?? vi.fn();
  const onNewItems = opts.onNewItems ?? vi.fn();
  const deps: InboxPollerDeps = { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, listLocalRepos: () => [], getAccount: () => (opts.account === undefined ? ACCOUNT : opts.account) };
  const poller = new InboxPoller(store, gh, onChange as never, onNewItems, deps);
  return { poller, clock, gh, store, cache, onChange, onNewItems };
}

describe('InboxPoller: startup and cache', () => {
  it('loads its initial state from the store cache', () => {
    const { store, cache } = fakeStore();
    cache.items = [item({ id: '5', unread: true }), item({ id: '6', unread: false })];
    cache.lastPolledAt = '2026-01-01T00:00:00Z';
    const gh = { notificationsPoll: vi.fn() } as unknown as GhClient;
    const poller = new InboxPoller(store, gh, vi.fn(), vi.fn(), { now: () => 0, setTimer: () => 0, clearTimer: () => {}, listLocalRepos: () => [], getAccount: () => ACCOUNT });
    expect(poller.getState()).toEqual({ items: cache.items, unreadCount: 1, lastPolledAt: '2026-01-01T00:00:00Z', paused: null, pausedUntil: null });
  });
});

describe('InboxPoller: scheduling', () => {
  it('start() polls immediately and reschedules using the greater of the server and setting intervals', async () => {
    const { poller, clock, gh } = makePoller({ settings: { notificationsPollIntervalMinutes: 2 }, gh: { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [], lastModified: 'L1', pollIntervalSeconds: 300 }) } });
    poller.start();
    expect(clock.calls).toHaveLength(1);
    expect(clock.calls[0].ms).toBe(0);
    await clock.fireLatest();
    expect(gh.notificationsPoll).toHaveBeenCalledTimes(1);
    // server asked for 300s, longer than the 120s setting: the next poll must not run sooner than that.
    expect(clock.calls[clock.calls.length - 1].ms).toBe(300_000);
  });

  it('uses the configured interval when it is longer than the server one', async () => {
    const { poller, clock } = makePoller({ settings: { notificationsPollIntervalMinutes: 10 }, gh: { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [], lastModified: null, pollIntervalSeconds: 60 }) } });
    poller.start();
    await clock.fireLatest();
    expect(clock.calls[clock.calls.length - 1].ms).toBe(600_000);
  });

  it('does not poll while idle for more than 30 minutes, and rechecks shortly instead', async () => {
    const { poller, clock, gh } = makePoller({});
    poller.start();
    await clock.fireLatest(); // first poll runs (not idle yet)
    expect(gh.notificationsPoll).toHaveBeenCalledTimes(1);
    clock.advance(IDLE_PAUSE_MS + 1000);
    await clock.fireLatest(); // this tick should see it has gone idle
    expect(gh.notificationsPoll).toHaveBeenCalledTimes(1);
    expect(clock.calls[clock.calls.length - 1].ms).toBe(60_000);
  });

  it('resumes and polls immediately on focus after being idle', async () => {
    const { poller, clock, gh } = makePoller({});
    poller.start();
    await clock.fireLatest();
    clock.advance(IDLE_PAUSE_MS + 1000);
    poller.onFocus();
    expect(clock.calls[clock.calls.length - 1].ms).toBe(0);
    await clock.fireLatest();
    expect(gh.notificationsPoll).toHaveBeenCalledTimes(2);
  });
});

describe('InboxPoller: polling outcomes', () => {
  it('treats a not-modified response as no change, leaving items and cache untouched', async () => {
    const { poller, cache } = makePoller({ gh: { notificationsPoll: vi.fn().mockResolvedValue({ notModified: true, pollIntervalSeconds: null }) } });
    const before = poller.getState();
    await poller.refresh();
    expect(poller.getState().items).toEqual(before.items);
    expect(cache.items).toEqual([]);
    expect(poller.getState().lastPolledAt).not.toBeNull();
  });

  it('maps new items, reports only newly-arrived unread ones, and persists the cache', async () => {
    const raw = { id: '9', unread: true, reason: 'mention', updated_at: '2026-02-01T00:00:00Z', last_read_at: null, subject: { title: 'You were mentioned', url: 'https://api.github.com/repos/octo/repo/issues/3', type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const onNewItems = vi.fn();
    const { poller, cache } = makePoller({ onNewItems, gh: { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [raw], lastModified: 'L2', pollIntervalSeconds: null }) } });
    await poller.refresh();
    expect(poller.getState().items).toHaveLength(1);
    expect(poller.getState().unreadCount).toBe(1);
    expect(onNewItems).toHaveBeenCalledTimes(1);
    expect((onNewItems.mock.calls[0][0] as InboxItem[])[0].id).toBe('9');
    expect(cache.items).toHaveLength(1);
    expect(cache.lastModified).toBe('L2');
  });

  it('does not re-report an item already seen on a previous poll', async () => {
    const raw = { id: '9', unread: true, reason: 'mention', updated_at: '2026-02-01T00:00:00Z', last_read_at: null, subject: { title: 'You were mentioned', url: 'https://api.github.com/repos/octo/repo/issues/3', type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const onNewItems = vi.fn();
    const { poller } = makePoller({ onNewItems, gh: { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [raw], lastModified: 'L2', pollIntervalSeconds: null }) } });
    await poller.refresh();
    await poller.refresh();
    expect(onNewItems).toHaveBeenCalledTimes(1);
  });

  it('pauses for rate-limit and resumes at the reset time without polling before it', async () => {
    const err = new GitError({ message: 'rate limited', command: '', exitCode: 1, stdout: '', stderr: '', code: 'rate-limited', rateLimitResetAt: '2026-01-01T00:05:00Z' });
    const { poller, clock, gh } = makePoller({ startTime: new Date('2026-01-01T00:00:00Z').getTime(), gh: { notificationsPoll: vi.fn().mockRejectedValue(err) } });
    poller.start();
    await clock.fireLatest();
    expect(poller.getState().paused).toBe('rate-limit');
    expect(poller.getState().pausedUntil).toBe('2026-01-01T00:05:00Z');
    expect(clock.calls[clock.calls.length - 1].ms).toBe(5 * 60_000);
    (gh.notificationsPoll as ReturnType<typeof vi.fn>).mockClear();
    await poller.refresh(); // an explicit refresh still short-circuits before the reset time
    expect(gh.notificationsPoll).not.toHaveBeenCalled();
  });

  it('marks the inbox offline on a network error and recovers on the next successful poll', async () => {
    const err = new GitError({ message: 'network down', command: '', exitCode: 1, stdout: '', stderr: '', code: 'network' });
    const gh = { notificationsPoll: vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ notModified: true, pollIntervalSeconds: null }) };
    const { poller } = makePoller({ gh });
    await poller.refresh();
    expect(poller.getState().paused).toBe('offline');
    await poller.refresh();
    expect(poller.getState().paused).toBeNull();
  });

  it('pauses with a scope reason and never calls gh when the notifications scope is missing', async () => {
    const gh = { notificationsPoll: vi.fn() };
    const { poller } = makePoller({ account: { ...ACCOUNT, scopes: ['gist'] }, gh });
    await poller.refresh();
    expect(poller.getState().paused).toBe('scope');
    expect(gh.notificationsPoll).not.toHaveBeenCalled();
  });

  it('does not poll at all while signed out', async () => {
    const gh = { notificationsPoll: vi.fn() };
    const { poller } = makePoller({ account: null, gh });
    await poller.refresh();
    expect(gh.notificationsPoll).not.toHaveBeenCalled();
  });

  it('does not poll for a non-github.com host (Enterprise Server is out of scope)', async () => {
    const gh = { notificationsPoll: vi.fn() };
    const { poller } = makePoller({ account: { ...ACCOUNT, host: 'github.example.com' }, gh });
    await poller.refresh();
    expect(gh.notificationsPoll).not.toHaveBeenCalled();
  });

  it('does not poll when notifications are disabled in settings', async () => {
    const gh = { notificationsPoll: vi.fn() };
    const { poller } = makePoller({ settings: { notificationsEnabled: false }, gh });
    await poller.refresh();
    expect(gh.notificationsPoll).not.toHaveBeenCalled();
  });
});

describe('InboxPoller: user actions', () => {
  it('markRead marks only the given threads read locally and persists the cache', async () => {
    const raw1 = { id: '1', unread: true, reason: 'mention', updated_at: '2026-01-01T00:00:00Z', last_read_at: null, subject: { title: 'a', url: null, type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const raw2 = { id: '2', unread: true, reason: 'mention', updated_at: '2026-01-01T00:00:00Z', last_read_at: null, subject: { title: 'b', url: null, type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const gh = { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [raw1, raw2], lastModified: null, pollIntervalSeconds: null }), markThreadRead: vi.fn().mockResolvedValue(undefined) };
    const { poller, cache } = makePoller({ gh });
    await poller.refresh();
    await poller.markRead(['1']);
    expect(gh.markThreadRead).toHaveBeenCalledWith('1');
    const items = poller.getState().items;
    expect(items.find((i) => i.id === '1')?.unread).toBe(false);
    expect(items.find((i) => i.id === '2')?.unread).toBe(true);
    expect(poller.getState().unreadCount).toBe(1);
    expect(cache.items.find((i) => i.id === '1')?.unread).toBe(false);
  });

  it('markAllRead marks every item read and zeroes the unread count', async () => {
    const raw = { id: '1', unread: true, reason: 'mention', updated_at: '2026-01-01T00:00:00Z', last_read_at: null, subject: { title: 'a', url: null, type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const gh = { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [raw], lastModified: null, pollIntervalSeconds: null }), markAllNotificationsRead: vi.fn().mockResolvedValue(undefined) };
    const { poller } = makePoller({ gh });
    await poller.refresh();
    await poller.markAllRead();
    expect(gh.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(poller.getState().unreadCount).toBe(0);
    expect(poller.getState().items.every((i) => !i.unread)).toBe(true);
  });

  it('resetCache clears items and the conditional-request cursor, forcing a full re-fetch next time', async () => {
    const raw = { id: '1', unread: true, reason: 'mention', updated_at: '2026-01-01T00:00:00Z', last_read_at: null, subject: { title: 'a', url: null, type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const gh = { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [raw], lastModified: 'L9', pollIntervalSeconds: null }) };
    const { poller, onChange } = makePoller({ gh });
    await poller.refresh();
    expect(poller.getState().items).toHaveLength(1);
    onChange.mockClear();
    poller.resetCache();
    expect(poller.getState()).toEqual({ items: [], unreadCount: 0, lastPolledAt: null, paused: null, pausedUntil: null });
    expect(onChange).toHaveBeenCalledTimes(1);
    (gh.notificationsPoll as ReturnType<typeof vi.fn>).mockClear();
    await poller.refresh();
    expect(gh.notificationsPoll).toHaveBeenCalledWith(null);
  });

  it('unsubscribe removes the item from the list', async () => {
    const raw = { id: '1', unread: true, reason: 'subscribed', updated_at: '2026-01-01T00:00:00Z', last_read_at: null, subject: { title: 'a', url: null, type: 'Issue' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };
    const gh = { notificationsPoll: vi.fn().mockResolvedValue({ notModified: false, items: [raw], lastModified: null, pollIntervalSeconds: null }), unsubscribeThread: vi.fn().mockResolvedValue(undefined) };
    const { poller } = makePoller({ gh });
    await poller.refresh();
    await poller.unsubscribe('1');
    expect(gh.unsubscribeThread).toHaveBeenCalledWith('1');
    expect(poller.getState().items).toHaveLength(0);
  });
});
