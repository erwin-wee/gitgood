import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_TAG, bridgeFetchAllowed, bridgeScript, WEB_BRIDGE_JS } from '../src/server/web-bridge';

describe('web bridge', () => {
  it('is syntactically valid JavaScript', () => {
    // Parses without executing (it references browser globals). A syntax error throws here.
    expect(() => new Function(WEB_BRIDGE_JS)).not.toThrow();
  });

  it('defines the same bridge surface api.ts consumes', () => {
    expect(WEB_BRIDGE_JS).toContain('window.gitgoodBridge');
    expect(WEB_BRIDGE_JS).toContain('invokeRaw');
    expect(WEB_BRIDGE_JS).toContain('platform');
    expect(WEB_BRIDGE_JS).toContain("fetch('/invoke'");
    expect(WEB_BRIDGE_JS).toContain('/events?token=');
  });

  it('injects no inline script (renderer CSP is script-src self)', () => {
    expect(BRIDGE_TAG).toMatch(/^(<script src="[^"]+"><\/script>)+$/);
  });

  it('served script sets config before the bridge reads it', () => {
    const win: Record<string, unknown> = {};
    new Function('window', bridgeScript('abc"123', 'linux', '1.2.3').replace(WEB_BRIDGE_JS, ''))(win);
    expect(win.__GITGOOD__).toEqual({ token: 'abc"123', platform: 'linux', version: '1.2.3' });
  });
});

describe('bridgeFetchAllowed (the script embeds the token)', () => {
  it('refuses requests the browser marks cross-site or same-site', () => {
    expect(bridgeFetchAllowed('cross-site')).toBe(false);
    expect(bridgeFetchAllowed('same-site')).toBe(false);
    expect(bridgeFetchAllowed(['cross-site'])).toBe(false);
  });

  it('allows same-origin loads, address-bar navigation and clients that send no fetch metadata', () => {
    expect(bridgeFetchAllowed('same-origin')).toBe(true);
    expect(bridgeFetchAllowed('none')).toBe(true);
    expect(bridgeFetchAllowed(undefined)).toBe(true);
  });
});

describe('bridge reconnect', () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeSocket.all.push(this);
    }
    close(): void {}
  }

  function boot(serverVersion: string) {
    FakeSocket.all = [];
    const events: [string, unknown][] = [];
    const win: Record<string, unknown> = { addEventListener() {}, crypto: { randomUUID: () => 'client-1' }, __GITGOOD__: { token: 't', platform: 'linux', version: '1.0.0' } };
    const doc = { addEventListener() {}, visibilityState: 'visible', hasFocus: () => true };
    const store = { getItem: () => 'client-1', setItem() {} };
    const fetchStub = async (url: string) => ({ ok: true, json: async () => (url === '/version' ? { version: serverVersion } : { ok: true, value: undefined }) });
    new Function('window', 'document', 'sessionStorage', 'location', 'WebSocket', 'fetch', WEB_BRIDGE_JS)(win, doc, store, { protocol: 'http:', host: 'h' }, FakeSocket, fetchStub);
    const bridge = win.gitgoodBridge as { on(event: string, listener: (payload: unknown) => void): void }; // the script under test installs it
    bridge.on('server.connection', (p) => events.push(['server.connection', p]));
    bridge.on('server.updated', (p) => events.push(['server.updated', p]));
    return events;
  }

  it('backs off exponentially up to 30s, resets once connected, and reports connection state', async () => {
    vi.useFakeTimers();
    try {
      const events = boot('1.0.0');
      const drop = async (expectedDelay: number) => {
        const before = FakeSocket.all.length;
        FakeSocket.all.at(-1)!.onclose!();
        await vi.advanceTimersByTimeAsync(expectedDelay - 1);
        expect(FakeSocket.all.length).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeSocket.all.length).toBe(before + 1);
      };
      for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) await drop(delay);
      FakeSocket.all.at(-1)!.onopen!();
      await drop(1000);
      // Connection events fire on transitions only: the first drop, the recovery, then the next drop.
      expect(events).toEqual([['server.connection', { connected: false }], ['server.connection', { connected: true }], ['server.connection', { connected: false }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces a server upgrade on reconnect, not when the version is unchanged', async () => {
    vi.useFakeTimers();
    try {
      for (const [serverVersion, expected] of [['2.0.0', [['server.updated', { version: '2.0.0' }]]], ['1.0.0', []]] as const) {
        const events = boot(serverVersion);
        FakeSocket.all[0].onopen!();
        FakeSocket.all[0].onclose!();
        await vi.advanceTimersByTimeAsync(1000);
        FakeSocket.all[1].onopen!();
        await vi.advanceTimersByTimeAsync(10);
        expect(events.filter(([name]) => name === 'server.updated')).toEqual(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
