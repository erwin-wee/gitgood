import { app, BrowserWindow, clipboard, dialog, nativeTheme, Notification, shell } from 'electron';
import type { AppSettings } from '@shared/types';
import type { ApiMethods } from '@shared/ipc';
import type { HostCapabilities } from '../core/host';

type ChooseDirectoryOptions = Parameters<ApiMethods['app.chooseDirectory']>[0];
type ChooseFileOptions = Parameters<ApiMethods['app.chooseFile']>[0];
type ChooseSavePathOptions = Parameters<ApiMethods['app.chooseSavePath']>[0];

/** The desktop implementation of `HostCapabilities`: the native dialogs, shell, clipboard, notifications, theme and window zoom. */
export class ElectronHost implements HostCapabilities {
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  appVersion(): string {
    return app.getVersion();
  }

  userDataPath(): string {
    return app.getPath('userData');
  }

  async chooseDirectory(opts: ChooseDirectoryOptions): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.getWindow()!, { title: opts.title, defaultPath: opts.defaultPath, buttonLabel: opts.buttonLabel, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  async chooseFile(opts: ChooseFileOptions): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.getWindow()!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties: ['openFile'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  async chooseSavePath(opts: ChooseSavePathOptions): Promise<string | null> {
    const result = await dialog.showSaveDialog(this.getWindow()!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
    return result.canceled || !result.filePath ? null : result.filePath;
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  async openPath(path: string): Promise<void> {
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  }

  async showItemInFolder(path: string): Promise<void> {
    shell.showItemInFolder(path);
  }

  async trashItem(path: string): Promise<void> {
    await shell.trashItem(path);
  }

  async clipboardWrite(text: string): Promise<void> {
    clipboard.writeText(text);
  }

  async notify(title: string, body: string): Promise<void> {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  }

  setTheme(theme: AppSettings['theme']): void {
    nativeTheme.themeSource = theme;
  }

  zoom(direction: 'in' | 'out' | 'reset'): number {
    const win = this.getWindow();
    if (!win) return 0;
    const current = win.webContents.getZoomLevel();
    const next = direction === 'reset' ? 0 : Math.max(-3, Math.min(4, current + (direction === 'in' ? 0.5 : -0.5)));
    win.webContents.setZoomLevel(next);
    return next;
  }
}
