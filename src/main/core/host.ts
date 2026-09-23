import type { ApiMethods } from '@shared/ipc';
import type { AppSettings } from '@shared/types';

type ChooseDirectoryOptions = Parameters<ApiMethods['app.chooseDirectory']>[0];
type ChooseFileOptions = Parameters<ApiMethods['app.chooseFile']>[0];
type ChooseSavePathOptions = Parameters<ApiMethods['app.chooseSavePath']>[0];

/**
 * Every native/host operation the handlers reach for, behind one interface so
 * `src/main/core` never imports `electron`. `ElectronHost` implements it with
 * the desktop behavior; `WebHost` (server mode) implements the network-safe
 * subset and returns `unsupported` for the rest.
 */
export interface HostCapabilities {
  appVersion(): string;
  userDataPath(): string;
  chooseDirectory(opts: ChooseDirectoryOptions): Promise<string | null>;
  chooseFile(opts: ChooseFileOptions): Promise<string | null>;
  chooseSavePath(opts: ChooseSavePathOptions): Promise<string | null>;
  /** Opens an already-validated http(s) URL in the user's browser. */
  openExternal(url: string): Promise<void>;
  /** Opens a file/directory with its OS default handler; throws on failure. */
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  trashItem(path: string): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  setTheme(theme: AppSettings['theme']): void;
  /** Applies a zoom step and returns the resulting zoom level. */
  zoom(direction: 'in' | 'out' | 'reset'): number;
}

/** Thrown by `WebHost` for capabilities with no safe web equivalent; surfaces as a typed `unsupported` IPC error. */
export class UnsupportedCapabilityError extends Error {
  constructor(capability: string) {
    super(`"${capability}" is not available in web mode.`);
    this.name = 'UnsupportedCapabilityError';
  }
}
