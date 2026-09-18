import type { UpdateState } from '@shared/types';
import { log } from '../logger';
import type { Store } from '../store';
import { detectDisabledReason, reduceUpdateState, type DisabledEnv } from './update-core';
import type { UpdateProvider } from './provider';

export type { DisabledEnv } from './update-core';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdaterDeps {
  getVersion: () => string;
  /** Fixed GitHub releases page, offered as the manual download link (never user-configurable — see the "feed is fixed" decision in design.md). */
  manualUrl: string;
  disabledEnv: DisabledEnv;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Orchestrates update checks: on launch and every 6 hours while
 * `checkForUpdatesAutomatically` is on, plus on-demand manual checks, always
 * against the fixed GitHub releases feed. All timing goes through
 * injectable now()/setTimer()/clearTimer() hooks (mirrors InboxPoller) so
 * the schedule can be driven with fake timers in tests. The state machine
 * itself lives in update-core.ts's reduceUpdateState, so this class is
 * mostly wiring: reading settings, calling the provider, and persisting/
 * broadcasting the result.
 */
export class Updater {
  private state: UpdateState;
  private timer: unknown = null;
  private disposed = false;
  private checking = false;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly store: Store,
    private readonly provider: UpdateProvider,
    private readonly onChange: (state: UpdateState) => void,
    private readonly deps: UpdaterDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    const disabledReason = detectDisabledReason(deps.disabledEnv);
    this.state = disabledReason ? { status: 'disabled', reason: disabledReason, manualUrl: deps.manualUrl } : { status: 'idle' };
  }

  getState(): UpdateState {
    return this.state;
  }

  /** Begins the launch check (if enabled) and schedules the 6-hour timer. No-op when disabled. */
  start(): void {
    if (this.state.status === 'disabled') {
      log.info(`Updater disabled: ${this.state.reason}`);
      return;
    }
    if (this.store.getSettings().checkForUpdatesAutomatically) void this.checkNow(false);
    this.scheduleNext();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
  }

  private scheduleNext(): void {
    if (this.disposed || this.state.status === 'disabled') return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      if (this.store.getSettings().checkForUpdatesAutomatically) void this.checkNow(false);
      this.scheduleNext();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Runs a check. `manual` distinguishes Help → Check for updates… / the
   * About dialog's Check now (which must surface a network error) from the
   * silent launch/timer checks (which only log a failure and leave the
   * previous state alone) — see the "Network error on manual check"
   * scenario.
   */
  async checkNow(manual: boolean): Promise<UpdateState> {
    if (this.state.status === 'disabled') return this.state;
    if (this.checking) return this.state;
    this.checking = true;
    const before = this.state;
    this.setState(reduceUpdateState(this.state, { type: 'check-start' }));
    log.info(`Checking for updates (${manual ? 'manual' : 'automatic'}, provider: ${this.provider.name})…`);
    try {
      const release = await this.provider.fetchLatestRelease();
      const channel = this.store.getSettings().updateChannel;
      this.setState(reduceUpdateState(this.state, { type: 'check-result', release, currentVersion: this.deps.getVersion(), channel }));
      log.info(`Update check result: ${this.state.status}${this.state.status === 'available' ? ` (${this.state.version})` : ''}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Update check failed: ${message}`);
      if (manual) this.setState(reduceUpdateState(this.state, { type: 'check-error', message, manualUrl: this.deps.manualUrl }));
      else this.setState(before);
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  /** "Later": hides the banner for this version until the app is next launched (see Store.AppStateFile.dismissedUpdateVersion for why this is not read back on startup). */
  dismiss(version: string): void {
    this.setState(reduceUpdateState(this.state, { type: 'dismiss', version }));
    this.store.updateState({ dismissedUpdateVersion: version });
  }

  private setState(next: UpdateState): void {
    this.state = next;
    this.onChange(next);
  }
}
