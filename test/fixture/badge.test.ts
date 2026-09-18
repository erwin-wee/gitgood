import { describe, expect, it, vi } from 'vitest';
import { app, BrowserWindow } from 'electron';
import { applyInboxBadge, renderBadgeBuffer } from '../../src/main/badge';

function withPlatform<T>(platform: string, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
}

describe('renderBadgeBuffer', () => {
  it('renders a 16x16 BGRA buffer', () => {
    const { width, height, buffer } = renderBadgeBuffer('3');
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(buffer.length).toBe(16 * 16 * 4);
  });

  it('paints some opaque pixels (the badge circle) for any label', () => {
    const { buffer } = renderBadgeBuffer('9+');
    let opaque = 0;
    for (let i = 3; i < buffer.length; i += 4) if (buffer[i] > 0) opaque++;
    expect(opaque).toBeGreaterThan(0);
  });

  it('caps the label at two characters, so "9+extra" renders identically to "9+"', () => {
    const short = renderBadgeBuffer('9+');
    const long = renderBadgeBuffer('9+extra');
    expect(long.buffer).toEqual(short.buffer);
  });
});

describe('applyInboxBadge', () => {
  it('sets the macOS dock badge to the count, and clears it at zero', () => {
    withPlatform('darwin', () => {
      const spy = vi.spyOn(app.dock, 'setBadge');
      applyInboxBadge(null, 4);
      expect(spy).toHaveBeenLastCalledWith('4');
      applyInboxBadge(null, 0);
      expect(spy).toHaveBeenLastCalledWith('');
      spy.mockRestore();
    });
  });

  it('sets the Linux/other launcher badge count via app.setBadgeCount', () => {
    withPlatform('linux', () => {
      const spy = vi.spyOn(app, 'setBadgeCount');
      applyInboxBadge(null, 3);
      expect(spy).toHaveBeenLastCalledWith(3);
      spy.mockRestore();
    });
  });

  it('sets and clears a Windows taskbar overlay icon on the window', () => {
    withPlatform('win32', () => {
      const win = new BrowserWindow() as unknown as { overlayIcon: unknown };
      applyInboxBadge(win as never, 12);
      expect(win.overlayIcon).not.toBeNull();
      applyInboxBadge(win as never, 0);
      expect(win.overlayIcon).toBeNull();
    });
  });

  it('is a no-op, never throwing, when there is no window on Windows', () => {
    withPlatform('win32', () => {
      expect(() => applyInboxBadge(null, 2)).not.toThrow();
    });
  });
});
