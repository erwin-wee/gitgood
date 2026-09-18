import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { log } from './logger';

/** 3x5 bitmap glyphs (one bit per column, MSB first) for the digits and "+" used in the unread-count overlay icon. */
const GLYPHS: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
};

const GLYPH_W = 3;
const GLYPH_H = 5;
const SIZE = 16;

/**
 * Renders a small red circular badge with a 1-2 character label ("1".."9",
 * "9+") for Windows' taskbar overlay icon. Built pixel-by-pixel with a tiny
 * bitmap font because the main process has no canvas/DOM to draw with. Pure
 * (besides the NativeImage wrapping), so its pixel buffer is unit-testable.
 */
export function renderBadgeBuffer(label: string): { width: number; height: number; buffer: Buffer } {
  const chars = [...label].slice(0, 2).join('');
  const buffer = Buffer.alloc(SIZE * SIZE * 4); // BGRA, top-left origin (electron's raw bitmap format)
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    buffer[i] = b;
    buffer[i + 1] = g;
    buffer[i + 2] = r;
    buffer[i + 3] = a;
  };
  const cx = SIZE / 2 - 0.5;
  const cy = SIZE / 2 - 0.5;
  const radius = SIZE / 2 - 0.5;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) setPixel(x, y, 218, 54, 51, 255); // GitHub "danger" red
    }
  }
  const glyphGap = 1;
  const totalWidth = chars.length * GLYPH_W + Math.max(0, chars.length - 1) * glyphGap;
  const startX = Math.floor((SIZE - totalWidth) / 2);
  const startY = Math.floor((SIZE - GLYPH_H) / 2);
  chars.split('').forEach((ch, ci) => {
    const glyph = GLYPHS[ch] ?? GLYPHS['0'];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (glyph[row] & (1 << (GLYPH_W - 1 - col))) setPixel(startX + ci * (GLYPH_W + glyphGap) + col, startY + row, 255, 255, 255, 255);
      }
    }
  });
  return { width: SIZE, height: SIZE, buffer };
}

export function renderBadgeIcon(label: string): NativeImage {
  const { width, height, buffer } = renderBadgeBuffer(label);
  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Shows the unread count as a Windows taskbar overlay, a macOS dock badge, or
 * a Linux launcher count (where the desktop environment supports it),
 * clearing it when the count is zero. Every platform call is wrapped so an
 * unsupported one is a silent no-op rather than a crash.
 */
export function applyInboxBadge(win: BrowserWindow | null, count: number): void {
  try {
    if (process.platform === 'win32') {
      if (!win || win.isDestroyed()) return;
      if (count > 0) win.setOverlayIcon(renderBadgeIcon(count > 9 ? '9+' : String(count)), `${count} unread notification${count === 1 ? '' : 's'}`);
      else win.setOverlayIcon(null, '');
    } else if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? (count > 99 ? '99+' : String(count)) : '');
    } else {
      app.setBadgeCount(count);
    }
  } catch (err) {
    log.warn(`Could not update the unread-notifications badge: ${(err as Error).message}`);
  }
}
