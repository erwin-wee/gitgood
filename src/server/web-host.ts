import type { AppSettings } from '@shared/types';
import { UnsupportedCapabilityError, type HostCapabilities } from '../main/core/host';

/**
 * The server implementation of `HostCapabilities`. The network-safe bits work;
 * everything that needs a local desktop (native dialogs, opening the OS shell,
 * the system clipboard, trash) throws `UnsupportedCapabilityError`, which the
 * core dispatch turns into a typed `unsupported` result the renderer already
 * tolerates. Notifications, theme and zoom are browser concerns, so they are
 * harmless no-ops here rather than errors. Phase 2 gives the dialogs and
 * clipboard real web stories.
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

  async trashItem(): Promise<void> {
    throw new UnsupportedCapabilityError('trashItem');
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
