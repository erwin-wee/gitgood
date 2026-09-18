import type { GitHubAccount, GitHubRepoRef, InboxItem, InboxState } from '@shared/types';
import { GitError } from '../git/git';
import { log } from '../logger';
import type { Store } from '../store';
import type { GhClient } from './gh';
import { toInboxItems, type RawNotification } from './inbox';

/** Polling stops once the window has gone this long without regaining focus. */
export const IDLE_PAUSE_MS = 30 * 60 * 1000;

/** GitHub's default `X-Poll-Interval` when the header is absent. */
const DEFAULT_POLL_SECONDS = 60;

export interface InboxPollerDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Local repository list to match notifications against; kept a plain sync accessor so polling never has to spawn git. */
  listLocalRepos: () => { id: string; github: GitHubRepoRef | null }[];
  getAccount: () => GitHubAccount | null;
}

/**
 * Polls GitHub notifications on a schedule derived from the server's
 * `X-Poll-Interval` and the user's own setting (whichever is longer), pauses
 * while the window has been unfocused for more than IDLE_PAUSE_MS, and
 * backs off on a rate limit or offline error. All timing goes through
 * injectable now()/setTimer()/clearTimer() hooks so the schedule can be
 * driven with fake timers in tests.
 */
export class InboxPoller {
  private state: InboxState;
  private lastModified: string | null;
  private serverPollSeconds = DEFAULT_POLL_SECONDS;
  private timer: unknown = null;
  private lastFocusAt: number;
  private polling = false;
  private disposed = false;
  private focused = true;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly listLocalRepos: () => { id: string; github: GitHubRepoRef | null }[];
  private readonly getAccount: () => GitHubAccount | null;

  constructor(
    private readonly store: Store,
    private readonly gh: GhClient,
    private readonly onChange: (state: InboxState) => void,
    private readonly onNewItems: (items: InboxItem[]) => void,
    deps: InboxPollerDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.listLocalRepos = deps.listLocalRepos;
    this.getAccount = deps.getAccount;
    this.lastFocusAt = this.now();
    const cache = this.store.getInboxCache();
    this.state = { items: cache.items, unreadCount: cache.items.filter((i) => i.unread).length, lastPolledAt: cache.lastPolledAt, paused: null, pausedUntil: null };
    this.lastModified = cache.lastModified;
  }

  getState(): InboxState {
    return this.state;
  }

  isFocused(): boolean {
    return this.focused;
  }

  /** Begins polling, immediately. */
  start(): void {
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
  }

  onFocus(): void {
    this.focused = true;
    this.lastFocusAt = this.now();
    this.schedule(0);
  }

  onBlur(): void {
    this.focused = false;
  }

  /** Forces an immediate poll (the "Refresh" action), rescheduling the regular timer around it. */
  async refresh(): Promise<InboxState> {
    await this.poll();
    this.schedule(this.nextDelayMs());
    return this.state;
  }

  async markRead(threadIds: string[]): Promise<void> {
    const ids = new Set(threadIds);
    for (const id of threadIds) {
      try {
        await this.gh.markThreadRead(id);
      } catch (err) {
        log.warn(`Could not mark notification ${id} read: ${(err as Error).message}`);
      }
    }
    const nowIso = new Date(this.now()).toISOString();
    const items = this.state.items.map((i) => (ids.has(i.id) ? { ...i, unread: false, lastReadAt: nowIso } : i));
    this.applyItems(items);
  }

  async markAllRead(): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    await this.gh.markAllNotificationsRead(nowIso);
    const items = this.state.items.map((i) => ({ ...i, unread: false, lastReadAt: nowIso }));
    this.applyItems(items);
  }

  /** Clears in-memory items and the conditional-request cursor, so the next poll fetches fresh (never a spurious "not modified") — pairs with `Store.clearInboxCache`, which drops the on-disk copy. */
  resetCache(): void {
    this.lastModified = null;
    this.setState({ items: [], unreadCount: 0, lastPolledAt: null, paused: null, pausedUntil: null });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.gh.unsubscribeThread(threadId);
    const items = this.state.items.filter((i) => i.threadId !== threadId);
    this.applyItems(items);
  }

  private applyItems(items: InboxItem[]): void {
    const next: InboxState = { ...this.state, items, unreadCount: items.filter((i) => i.unread).length };
    this.setState(next);
    this.store.setInboxCache({ items, lastModified: this.lastModified, lastPolledAt: this.state.lastPolledAt });
  }

  private idle(): boolean {
    return this.now() - this.lastFocusAt > IDLE_PAUSE_MS;
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.idle()) {
      // Nothing to poll while idle; check back periodically in case focus never fires again.
      this.schedule(60_000);
      return;
    }
    await this.poll();
    if (this.disposed) return;
    if (this.state.paused === 'rate-limit' && this.state.pausedUntil) {
      this.schedule(Math.max(5000, new Date(this.state.pausedUntil).getTime() - this.now()));
      return;
    }
    this.schedule(this.nextDelayMs());
  }

  private nextDelayMs(): number {
    const settingMinutes = this.store.getSettings().notificationsPollIntervalMinutes || 2;
    const seconds = Math.max(this.serverPollSeconds, settingMinutes * 60);
    return seconds * 1000;
  }

  private setState(next: InboxState): void {
    this.state = next;
    this.onChange(next);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    if (!this.store.getSettings().notificationsEnabled) return;
    const account = this.getAccount();
    if (!account) return; // signed out: the toolbar bell shows a sign-in dot instead of polling
    if (account.host !== 'github.com') return; // Enterprise Server hosts are out of scope for v1; the panel shows a note instead of polling
    if (this.state.paused === 'rate-limit' && this.state.pausedUntil && new Date(this.state.pausedUntil).getTime() > this.now()) return;
    if (account.scopes.length && !account.scopes.some((s) => s === 'notifications' || s === 'repo')) {
      if (this.state.paused !== 'scope') this.setState({ ...this.state, paused: 'scope', pausedUntil: null });
      return;
    }
    this.polling = true;
    try {
      const result = await this.gh.notificationsPoll(this.lastModified);
      if (result.pollIntervalSeconds) this.serverPollSeconds = Math.max(DEFAULT_POLL_SECONDS, result.pollIntervalSeconds);
      const lastPolledAt = new Date(this.now()).toISOString();
      if (result.notModified) {
        this.setState({ ...this.state, lastPolledAt, paused: null, pausedUntil: null });
        return;
      }
      const repos = this.listLocalRepos();
      const items = toInboxItems(result.items as RawNotification[], repos);
      const previouslyKnown = new Set(this.state.items.map((i) => i.id));
      const newlyArrived = items.filter((i) => i.unread && !previouslyKnown.has(i.id));
      this.lastModified = result.lastModified ?? this.lastModified;
      const nextState: InboxState = { items, unreadCount: items.filter((i) => i.unread).length, lastPolledAt, paused: null, pausedUntil: null };
      this.setState(nextState);
      this.store.setInboxCache({ items, lastModified: this.lastModified, lastPolledAt });
      if (newlyArrived.length) this.onNewItems(newlyArrived);
    } catch (err) {
      this.handlePollError(err);
    } finally {
      this.polling = false;
    }
  }

  private handlePollError(err: unknown): void {
    if (err instanceof GitError) {
      if (err.info.code === 'rate-limited') {
        this.setState({ ...this.state, paused: 'rate-limit', pausedUntil: err.info.rateLimitResetAt ?? null });
        return;
      }
      if (err.info.code === 'network') {
        this.setState({ ...this.state, paused: 'offline', pausedUntil: null });
        return;
      }
      if (err.info.code === 'gh-not-authenticated') {
        this.setState({ ...this.state, paused: null, pausedUntil: null });
        return;
      }
    }
    log.warn(`Notifications poll failed: ${(err as Error).message}`);
  }
}
