import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '../shared/ipc';

const bridge = {
  platform: process.platform,
  invokeRaw: (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, method, ...args),
  on: (event: string, listener: (payload: unknown) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, name: string, payload: unknown) => {
      if (name === event) listener(payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler);
  },
};

// Both desktop modes keep the desktop layout at any window width or zoom (see the `data-desktop` guards in the stylesheets).
contextBridge.exposeInMainWorld('gitgoodDesktop', true);

// `--gitgood-client` is passed by `createMainWindow` in desktop client mode (`src/main/client.ts`).
if (process.argv.includes('--gitgood-client')) {
  // The page is the server's, with its web bridge (`src/server/web-bridge.ts`), which layers these native hooks over HTTP.
  contextBridge.exposeInMainWorld('gitgoodNative', {
    /** Resolves an IpcResult when the desktop answers `method` natively, else null. */
    invoke: (method: string, args: unknown[]): Promise<unknown> => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, method, ...args),
    /** Hands a server event to the desktop shell (unread badge, OS notifications). */
    serverEvent: (event: string, payload: unknown): void => ipcRenderer.send(IPC_EVENT_CHANNEL, event, payload),
    /** Native events for the renderer: window focus, theme, menu and protocol-link actions. */
    onEvent: (listener: (event: string, payload: unknown) => void): void => {
      ipcRenderer.on(IPC_EVENT_CHANNEL, (_e: IpcRendererEvent, name: string, payload: unknown) => listener(name, payload));
    },
  });
} else {
  contextBridge.exposeInMainWorld('gitgoodBridge', bridge);
}

export type GitGoodBridge = typeof bridge;
