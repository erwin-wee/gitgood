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

contextBridge.exposeInMainWorld('gitgoodBridge', bridge);

export type GitGoodBridge = typeof bridge;
