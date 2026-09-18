/**
 * Minimal `electron` replacement aliased in for the vitest `fixture` project
 * (see vitest.config.ts) so main-process modules that import `electron`
 * (currently `store.ts`) can load under plain Node without Electron installed
 * or running. Only the surface those modules touch is implemented.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths: Record<string, string> = {
  userData: process.env.GITGOOD_USER_DATA || join(tmpdir(), 'gitgood-fixture-userdata'),
  documents: join(tmpdir(), 'gitgood-fixture-documents'),
  home: tmpdir(),
  temp: tmpdir(),
  logs: join(tmpdir(), 'gitgood-fixture-logs'),
};

export const app = {
  getPath(name: string): string {
    return paths[name] ?? join(tmpdir(), `gitgood-fixture-${name}`);
  },
  setPath(name: string, value: string): void {
    paths[name] = value;
  },
  getVersion(): string {
    return '0.0.0-test';
  },
  getName(): string {
    return 'GitGood';
  },
  setName(): void {},
  setAppUserModelId(): void {},
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  on: () => {},
  once: () => {},
  quit: () => {},
  requestSingleInstanceLock: () => true,
  isDefaultProtocolClient: () => true,
  setAsDefaultProtocolClient: () => {},
  dock: { setBadge: (_label: string) => {} },
  setBadgeCount: (_count: number): boolean => true,
};

/** Minimal `nativeImage` stand-in: `renderBadgeIcon` only needs `createFromBuffer` to return something it can hand to `win.setOverlayIcon`. */
export const nativeImage = {
  createFromBuffer(buffer: Buffer, opts: { width: number; height: number }): { isEmpty: () => boolean; getSize: () => { width: number; height: number }; buffer: Buffer } {
    return { isEmpty: () => buffer.length === 0, getSize: () => opts, buffer };
  },
  createEmpty(): { isEmpty: () => boolean } {
    return { isEmpty: () => true };
  },
};

/** Identity "encryption": good enough for tests, never used for real secrets. */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString(value: string): Buffer {
    return Buffer.from(value, 'utf8');
  },
  decryptString(buffer: Buffer): string {
    return buffer.toString('utf8');
  },
};

export class BrowserWindow {
  static instances: BrowserWindow[] = [];
  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.instances;
  }
  webContents = {
    on: () => {},
    once: () => {},
    send: () => {},
    executeJavaScript: async () => undefined,
    invalidate: () => {},
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
  };
  constructor(_opts?: unknown) {
    BrowserWindow.instances.push(this);
  }
  on(): void {}
  once(): void {}
  isMinimized(): boolean {
    return false;
  }
  isDestroyed(): boolean {
    return false;
  }
  restore(): void {}
  focus(): void {}
  show(): void {}
  loadURL(): void {}
  loadFile(): void {}
  overlayIcon: { icon: unknown; description: string } | null = null;
  setOverlayIcon(icon: unknown, description: string): void {
    this.overlayIcon = icon ? { icon, description } : null;
  }
}

export const Menu = {
  setApplicationMenu: () => {},
  buildFromTemplate: () => ({}),
};

export const nativeTheme = {
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: false,
  on: () => {},
};

export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
export const shell = { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} };
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
  showMessageBox: async () => ({ response: 0 }),
};
export const clipboard = { writeText: () => {}, readText: () => '' };

export class Notification {
  static supported = true;
  static isSupported(): boolean {
    return Notification.supported;
  }
  private clickHandler: (() => void) | null = null;
  constructor(public opts: { title: string; body: string }) {}
  on(event: string, handler: () => void): void {
    if (event === 'click') this.clickHandler = handler;
  }
  show(): void {}
  click(): void {
    this.clickHandler?.();
  }
}

export default { app, safeStorage, BrowserWindow, Menu, nativeTheme, ipcMain, shell, dialog, clipboard, nativeImage, Notification };
