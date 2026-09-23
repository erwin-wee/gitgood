import { describe, expect, it } from 'vitest';
import { BRIDGE_TAG, bridgeScript, WEB_BRIDGE_JS } from '../src/server/web-bridge';

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
    new Function('window', bridgeScript('abc"123', 'linux').replace(WEB_BRIDGE_JS, ''))(win);
    expect(win.__GITGOOD__).toEqual({ token: 'abc"123', platform: 'linux' });
  });
});
