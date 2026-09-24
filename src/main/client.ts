import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dialog, ipcMain, nativeTheme, Notification, type BrowserWindow } from 'electron';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL, type ApiMethods } from '@shared/ipc';
import type { InboxItem, InboxState, IpcResult } from '@shared/types';
import { applyInboxBadge } from './badge';
import { ElectronHost } from './host/electron-host';
import { sendEvent } from './ipc';
import { log } from './logger';
import type { Store } from './store';

/**
 * The GitGood server this desktop app is a client of: `GITGOOD_SERVER_URL`,
 * else the contents of `<userData>/server-url`. Null runs the app standalone.
 * Throws on a malformed URL so a typo never silently falls back to a
 * standalone app with its own, diverging settings.
 */
export function clientServerUrl(userData: string): string | null {
  let raw = process.env.GITGOOD_SERVER_URL;
  if (!raw) {
    try {
      raw = readFileSync(join(userData, 'server-url'), 'utf8');
    } catch {
      return null;
    }
  }
  return raw.trim() ? new URL(raw.trim()).origin : null;
}

/**
 * Warns once when this desktop build and the server differ: the window runs the
 * server's renderer against this build's native IPC, so a skew can leave
 * features half-working. Called on every load; loads that can't reach the
 * server (the retry page) are ignored.
 */
export function watchServerVersion(serverUrl: string, win: BrowserWindow, desktopVersion: string): void {
  let warned = false;
  win.webContents.on('did-finish-load', async () => {
    if (warned) return;
    let body: unknown;
    try {
      body = await (await fetch(`${serverUrl}/version`)).json();
    } catch {
      return;
    }
    const server = body && typeof body === 'object' && 'version' in body && typeof body.version === 'string' ? body.version : null;
    if (!server || server === desktopVersion || warned || win.isDestroyed()) return;
    warned = true;
    log.warn(`Desktop ${desktopVersion} is using GitGood server ${server}`);
    void dialog.showMessageBox(win, {
      type: 'warning',
      message: `GitGood ${desktopVersion} is connected to a GitGood server running ${server}.`,
      detail: 'Update or rebuild the one that is behind so both run the same version; until then some features may not work.',
    });
  });
}

/** Desktop notification for an inbox item; clicking it focuses the window and opens the item. */
export function showInboxNotification(getWindow: () => BrowserWindow | null, item: InboxItem): void {
  const n = new Notification({ title: `${item.repo.owner}/${item.repo.name}`, body: item.subject.title });
  n.on('click', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendEvent(win, 'menu.action', { action: 'open-inbox-item', args: { id: item.id } });
  });
  n.show();
}

/**
 * Whether the local server's path confinement allows `path`: `app.pathExists`
 * is checked against its allowed locations like every other path argument.
 * The token comes from the served bridge script, the same way the page gets it
 * (loopback callers are trusted with it); fetched per call since these
 * actions are rare and the token can change when the server's data is reset.
 */
async function serverAllows(serverUrl: string, path: string): Promise<boolean> {
  try {
    const script = await (await fetch(`${serverUrl}/gitgood-bridge.js`)).text();
    const token = /"token":"([0-9a-f]+)"/.exec(script)?.[1];
    if (!token) return false;
    const res = await fetch(`${serverUrl}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'app.pathExists', args: [path] }),
    });
    const result: unknown = await res.json();
    return result !== null && typeof result === 'object' && 'ok' in result && result.ok === true;
  } catch {
    return false;
  }
}

/**
 * Client mode: the window runs the server-served renderer and web bridge
 * (`src/server/web-bridge.ts`); everything goes to the server except the
 * native capabilities answered here. The bridge sends every call here first
 * and falls back to its web path when this resolves null.
 */
export function registerClientIpc(serverUrl: string, store: Store, getWindow: () => BrowserWindow | null): void {
  const host = new ElectronHost(getWindow);
  // Paths the renderer holds are the server's: native file dialogs and shell actions only make sense when it shares this machine's filesystem.
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(serverUrl).hostname);
  const always: Partial<ApiMethods> = {
    'app.clipboard.write': (text) => host.clipboardWrite(text),
    'app.openExternal': async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      await host.openExternal(url);
    },
    'app.notify': (title, body) => host.notify(title, body),
    'app.zoom': async (direction) => {
      const next = host.zoom(direction);
      store.updateState({ zoomLevel: next });
      return next;
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Only available when the GitGood server runs on this machine.');
  };
  // The page is the server's, so its paths get the server's confinement before the desktop acts on them natively.
  const confined =
    (fn: (path: string) => Promise<void>) =>
    async (path: string): Promise<void> => {
      if (!(await serverAllows(serverUrl, path))) throw new Error(`"${path}" is outside the server's allowed locations.`);
      await fn(path);
    };
  const native: Partial<ApiMethods> = local
    ? {
        ...always,
        'app.chooseDirectory': (opts) => host.chooseDirectory(opts),
        'app.chooseFile': (opts) => host.chooseFile(opts),
        'app.chooseSavePath': (opts) => host.chooseSavePath(opts),
        'app.openPath': confined((p) => host.openPath(p)),
        'app.showItemInFolder': confined((p) => host.showItemInFolder(p)),
        'app.moveToTrash': confined((p) => host.trashItem(p)),
      }
    : { ...always, 'app.openInEditor': unsupported, 'app.openInShell': unsupported };

  ipcMain.handle(IPC_INVOKE_CHANNEL, async (_event, method: string, ...args: unknown[]): Promise<IpcResult<unknown> | null> => {
    const fn = native[method as keyof ApiMethods] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!fn) return null;
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: { message: (err as Error).message, command: '', exitCode: null, stderr: '', stdout: '', code: 'unsupported' } };
    }
  });

  // Server events the bridge forwards for the desktop shell itself.
  ipcMain.on(IPC_EVENT_CHANNEL, (_event, name: string, payload: unknown) => {
    if (name === 'gh.inbox.changed') applyInboxBadge(getWindow(), (payload as InboxState).unreadCount);
    else if (name === 'gh.inbox.new' && !getWindow()?.isFocused() && Notification.isSupported()) {
      for (const item of payload as InboxItem[]) showInboxNotification(getWindow, item);
    }
  });

  nativeTheme.on('updated', () => sendEvent(getWindow(), 'theme.changed', { dark: nativeTheme.shouldUseDarkColors }));
}
