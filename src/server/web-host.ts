import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AppSettings } from '@shared/types';
import { UnsupportedCapabilityError, type HostCapabilities } from '../main/core/host';

/**
 * The server implementation of `HostCapabilities`. The network-safe bits work;
 * everything that needs a local desktop (native dialogs, opening the OS shell,
 * the system clipboard) throws `UnsupportedCapabilityError`, which the
 * core dispatch turns into a typed `unsupported` result the renderer already
 * tolerates. Trash is a folder in the server's data directory. Notifications,
 * theme and zoom are browser concerns, so they are harmless no-ops here.
 */
export class WebHost implements HostCapabilities {
  constructor(
    private readonly version: string,
    private readonly userData: string,
  ) {}

  appVersion(): string {
    return this.version;
  }

  userDataPath(): string {
    return this.userData;
  }

  async chooseDirectory(): Promise<string | null> {
    throw new UnsupportedCapabilityError('chooseDirectory');
  }

  async chooseFile(): Promise<string | null> {
    throw new UnsupportedCapabilityError('chooseFile');
  }

  async chooseSavePath(): Promise<string | null> {
    throw new UnsupportedCapabilityError('chooseSavePath');
  }

  async openExternal(): Promise<void> {
    throw new UnsupportedCapabilityError('openExternal');
  }

  async openPath(): Promise<void> {
    throw new UnsupportedCapabilityError('openPath');
  }

  async showItemInFolder(): Promise<void> {
    throw new UnsupportedCapabilityError('showItemInFolder');
  }

  /**
   * Moves the item into its own `<userData>/trash/<timestamp>-XXXXXX/`
   * (unique, so two same-named files trashed together never overwrite each
   * other), keeping discards and repository removals that asked for the trash
   * recoverable on a server with no desktop trash.
   */
  async trashItem(path: string): Promise<void> {
    const root = join(this.userData, 'trash');
    await mkdir(root, { recursive: true });
    const target = join(await mkdtemp(join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-`)), basename(path));
    try {
      await rename(path, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await cp(path, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      await rm(path, { recursive: true, force: true });
    }
  }

  async clipboardWrite(): Promise<void> {
    throw new UnsupportedCapabilityError('clipboardWrite');
  }

  async notify(): Promise<void> {
    // No desktop to notify; the web client surfaces state in-page.
  }

  setTheme(_theme: AppSettings['theme']): void {
    // Theme is applied client-side from settings; nothing to do on the server.
  }

  zoom(): number {
    // Zoom is native to the browser in web mode.
    return 0;
  }
}
