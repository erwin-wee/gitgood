import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { StorePlatform } from '../core/store-platform';

/** Desktop `StorePlatform`: OS keychain via `safeStorage`, Documents dir and version via `app`. */
export const electronStorePlatform: StorePlatform = {
  // Headless Windows sessions may not register a shell Documents known-folder.
  documentsDir: () => {
    try {
      return app.getPath('documents');
    } catch {
      return join(app.getPath('home'), 'Documents');
    }
  },
  appVersion: () => app.getVersion(),
  encryptSecret: (value) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : null),
  decryptSecret: (payload) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(payload, 'base64')) : null),
};
