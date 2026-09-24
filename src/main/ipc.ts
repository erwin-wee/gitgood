import { BrowserWindow, ipcMain } from 'electron';
import type { ApiMethodName, EventPayloads } from '@shared/ipc';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc';
import type { IpcResult } from '@shared/types';
import { createHandlers, type HandlerDeps } from './core/handlers';

export type { HandlerDeps } from './core/handlers';

/** Low-level event send to a single window; the desktop app subscribes the core event bus to this. */
export function sendEvent<K extends keyof EventPayloads>(win: BrowserWindow | null, event: K, payload: EventPayloads[K]): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC_EVENT_CHANNEL, event, payload);
}

/** Binds the Electron-free core dispatch to `ipcMain` for the desktop app. */
export function registerIpc(deps: HandlerDeps): void {
  const { dispatch } = createHandlers(deps);
  ipcMain.handle(IPC_INVOKE_CHANNEL, (_event, method: ApiMethodName, ...args: unknown[]): Promise<IpcResult<unknown>> => dispatch(method, args));
}
