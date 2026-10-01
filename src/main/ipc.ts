import { BrowserWindow, ipcMain } from 'electron';
import type { ApiMethodName, EventPayloads } from '@shared/ipc';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc';
import type { IpcResult } from '@shared/types';
import { clientContext } from './core/client-context';
import { windowClientId } from './core/event-routing';
import { createHandlers, type HandlerDeps } from './core/handlers';
import { appEntryUrl, isTrustedSender } from './app-url';

export type { HandlerDeps } from './core/handlers';

/** Low-level event send to a single window; the desktop app subscribes the core event bus to this. */
export function sendEvent<K extends keyof EventPayloads>(win: BrowserWindow | null, event: K, payload: EventPayloads[K]): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC_EVENT_CHANNEL, event, payload);
}

/** Binds the Electron-free core dispatch to `ipcMain` for the desktop app. Each call runs as the client of the window that sent it, so every window has its own open repository, watcher and in-flight jobs. */
export function registerIpc(deps: HandlerDeps): void {
  const { dispatch } = createHandlers(deps);
  const entry = appEntryUrl();
  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, method: ApiMethodName, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    if (!isTrustedSender(event, entry)) throw new Error('IPC refused: sender is not the app window.');
    return clientContext.run(windowClientId(event.sender.id), () => dispatch(method, args));
  });
}
