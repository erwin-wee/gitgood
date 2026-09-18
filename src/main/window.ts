import { join } from 'node:path';
import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { debounce } from '@shared/util';
import type { Store } from './store';
import { sendEvent } from './ipc';

/**
 * Automated smoke runs render offscreen and never show the window, so a test
 * pass does not steal focus from whatever the developer is doing. Set
 * GITGOOD_SMOKE_SHOW=1 to watch the app during a smoke run instead.
 */
export function smokeHeadless(): boolean {
  return !!process.env.GITGOOD_SMOKE_SCRIPT && process.env.GITGOOD_SMOKE_SHOW !== '1';
}

export function createMainWindow(store: Store, onFocusChange?: (focused: boolean) => void): BrowserWindow {
  const state = store.getState();
  const headless = smokeHeadless();
  const bounds = state.window;
  const display = screen.getDisplayMatching({ x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width, height: bounds.height });
  const fitsOnScreen = bounds.x !== undefined && bounds.y !== undefined && bounds.x >= display.bounds.x - 50 && bounds.y >= display.bounds.y - 50 && bounds.x < display.bounds.x + display.bounds.width && bounds.y < display.bounds.y + display.bounds.height;
  const dark = nativeTheme.shouldUseDarkColors;

  const win = new BrowserWindow({
    width: Math.min(bounds.width, display.workAreaSize.width),
    height: Math.min(bounds.height, display.workAreaSize.height),
    x: fitsOnScreen ? bounds.x : undefined,
    y: fitsOnScreen ? bounds.y : undefined,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'GitGood',
    backgroundColor: dark ? '#0d1117' : '#ffffff',
    autoHideMenuBar: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      zoomFactor: 1,
      backgroundThrottling: !process.env.GITGOOD_SMOKE_SCRIPT,
      offscreen: headless,
    },
  });

  if (headless) win.webContents.setFrameRate(30);
  if (bounds.maximized && !headless) win.maximize();

  const saveBounds = debounce(() => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    store.updateState({ window: { ...store.getState().window, x: b.x, y: b.y, width: b.width, height: b.height, maximized } });
  }, 400);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);
  win.on('focus', () => {
    sendEvent(win, 'window.focus', { focused: true });
    onFocusChange?.(true);
  });
  win.on('blur', () => {
    sendEvent(win, 'window.focus', { focused: false });
    onFocusChange?.(false);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL ?? 'file://';
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => {
    win.webContents.setZoomLevel(state.zoomLevel ?? 0);
    if (!headless) win.show();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}
