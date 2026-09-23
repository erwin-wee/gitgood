import { app, safeStorage } from 'electron';
import type { StorePlatform } from '../core/store-platform';

/** Desktop `StorePlatform`: OS keychain via `safeStorage`, Documents dir and version via `app`. */
export const electronStorePlatform: StorePlatform = {
  documentsDir: () => app.getPath('documents'),
  appVersion: () => app.getVersion(),
  encryptSecret: (value) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : null),
  decryptSecret: (payload) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(payload, 'base64')) : null),
};
