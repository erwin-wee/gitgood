import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/main/store';
import type { UpdateProvider } from '../../src/main/update/provider';
import type { ReleaseInfo } from '../../src/main/update/update-core';
import { Updater } from '../../src/main/update/updater';
import type { UpdateState } from '../../src/shared/types';

/** A provider whose one release is set by the test, so checks are deterministic without any network or `gh` process. */
class FakeProvider implements UpdateProvider {
  readonly name = 'fake';
  release: ReleaseInfo | null = null;
  error: Error | null = null;
  calls = 0;

  async fetchLatestRelease(): Promise<ReleaseInfo | null> {
    this.calls++;
    if (this.error) throw this.error;
    return this.release;
  }
}

/** A trivial fake timer: setTimer records (fn, ms) and returns a ticket; advance() runs whichever timers are due. Good enough for the 6-hour interval and dispose() without real waiting. */
function fakeClock() {
  let now = 0;
  const timers = new Map<number, { fn: () => void; due: number }>();
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    /** Advances virtual time and runs any timers now due (once each, in id order). */
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[0] - b[0])) {
        if (t.due <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

async function withUpdater(fn: (updater: Updater, provider: FakeProvider, store: Store, changes: UpdateState[], clock: ReturnType<typeof fakeClock>) => Promise<void>, disabledEnvOverrides: Partial<{ isPackaged: boolean }> = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gg-updater-'));
  try {
    const store = new Store(dir);
    store.load();
    const provider = new FakeProvider();
    const changes: UpdateState[] = [];
    const clock = fakeClock();
    const updater = new Updater(store, provider, (s) => changes.push(s), {
      getVersion: () => '1.0.0',
      manualUrl: 'https://github.com/erwin-wee/gitgood/releases',
      disabledEnv: { isPackaged: true, platform: 'linux', portableExecutableDir: undefined, appImagePath: undefined, appImageWritable: false, ...disabledEnvOverrides },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await fn(updater, provider, store, changes, clock);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Updater', () => {
  it('starts idle and reports up-to-date when the launch check finds no newer release', async () => {
    await withUpdater(async (updater, _provider, _store, changes) => {
      expect(updater.getState()).toEqual({ status: 'idle' });
      updater.start();
      await new Promise((r) => setTimeout(r, 0)); // flush the microtask queue for the fire-and-forget launch check
      expect(updater.getState()).toEqual({ status: 'up-to-date' });
      expect(changes.at(-1)).toEqual({ status: 'up-to-date' });
      updater.dispose();
    });
  });

  it('reports available for a newer release on the stable channel', async () => {
    await withUpdater(async (updater, provider) => {
      provider.release = { version: '2.0.0', releaseDate: null, notes: 'New stuff', url: 'https://x/2.0.0', prerelease: false, draft: false };
      const state = await updater.checkNow(true);
      expect(state).toEqual({ status: 'available', version: '2.0.0', releaseDate: null, notes: 'New stuff', url: 'https://x/2.0.0', prerelease: false, dismissed: false });
      updater.dispose();
    });
  });

  it('does not offer a prerelease on the stable channel', async () => {
    await withUpdater(async (updater, provider) => {
      provider.release = { version: '2.0.0-beta.1', releaseDate: null, notes: null, url: 'https://x', prerelease: true, draft: false };
      expect(await updater.checkNow(true)).toEqual({ status: 'up-to-date' });
      updater.dispose();
    });
  });

  it('offers a prerelease once the channel setting is switched to beta', async () => {
    await withUpdater(async (updater, provider, store) => {
      store.updateSettings({ updateChannel: 'beta' });
      provider.release = { version: '2.0.0-beta.1', releaseDate: null, notes: null, url: 'https://x', prerelease: true, draft: false };
      const state = await updater.checkNow(true);
      expect(state.status).toBe('available');
      updater.dispose();
    });
  });

  it('a manual check surfaces a network error; a silent (launch/timer) check only logs it and leaves the state alone', async () => {
    await withUpdater(async (updater, provider) => {
      provider.error = new Error('network down');
      const manual = await updater.checkNow(true);
      expect(manual).toEqual({ status: 'error', message: 'network down', manualUrl: 'https://github.com/erwin-wee/gitgood/releases' });

      // Reset to a known non-error state, then fail silently: the prior state must be restored, not stuck in 'checking' or turned into an error toast.
      provider.error = null;
      provider.release = null;
      await updater.checkNow(false);
      expect(updater.getState()).toEqual({ status: 'up-to-date' });
      provider.error = new Error('network down again');
      await updater.checkNow(false);
      expect(updater.getState()).toEqual({ status: 'up-to-date' });
      updater.dispose();
    });
  });

  it('dismiss marks the current available version as dismissed and persists it to the store', async () => {
    await withUpdater(async (updater, provider, store) => {
      provider.release = { version: '2.0.0', releaseDate: null, notes: null, url: 'https://x', prerelease: false, draft: false };
      await updater.checkNow(true);
      updater.dismiss('2.0.0');
      expect(updater.getState()).toMatchObject({ status: 'available', dismissed: true });
      expect(store.getState().dismissedUpdateVersion).toBe('2.0.0');
      updater.dispose();
    });
  });

  it('a disabled build never checks at all, even when asked manually', async () => {
    await withUpdater(
      async (updater, provider) => {
        expect(updater.getState()).toMatchObject({ status: 'disabled' });
        updater.start();
        const state = await updater.checkNow(true);
        expect(state.status).toBe('disabled');
        expect(provider.calls).toBe(0);
        updater.dispose();
      },
      { isPackaged: false },
    );
  });

  it('re-checks on the 6-hour timer while automatic checks are enabled, and stops once disposed', async () => {
    await withUpdater(async (updater, provider, _store, _changes, clock) => {
      updater.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(provider.calls).toBe(1);
      clock.advance(6 * 60 * 60 * 1000);
      await new Promise((r) => setTimeout(r, 0));
      expect(provider.calls).toBe(2);
      updater.dispose();
      clock.advance(6 * 60 * 60 * 1000);
      await new Promise((r) => setTimeout(r, 0));
      expect(provider.calls).toBe(2); // disposed: no further checks
    });
  });

  it('does not check on launch or on the timer when the automatic-check setting is off, but a manual check still works', async () => {
    await withUpdater(async (updater, provider, store, _changes, clock) => {
      store.updateSettings({ checkForUpdatesAutomatically: false });
      updater.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(provider.calls).toBe(0);
      clock.advance(6 * 60 * 60 * 1000);
      await new Promise((r) => setTimeout(r, 0));
      expect(provider.calls).toBe(0);
      await updater.checkNow(true);
      expect(provider.calls).toBe(1);
      updater.dispose();
    });
  });
});
