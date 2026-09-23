import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The host-specific bits `Store` needs that differ between the Electron desktop
 * (OS keychain via `safeStorage`, `app.getPath`/`app.getVersion`) and a headless
 * server. Keeping them behind this interface lets `Store` stay Electron-free so
 * the server can mount it.
 */
export interface StorePlatform {
  /** Default parent directory for new clones (the OS "Documents" folder). */
  documentsDir(): string;
  /** Running application version, stamped into settings exports. */
  appVersion(): string;
  /** Encrypts a secret for at-rest storage, or returns null when no OS keychain is available (caller falls back to restricted-permission plaintext). */
  encryptSecret(value: string): string | null;
  /** Decrypts a payload produced by `encryptSecret`, or returns null when unavailable/failed. */
  decryptSecret(payload: string): string | null;
}

/** Electron-free default used by the server and tests: no OS keychain, Documents under the home directory. */
export const nodeStorePlatform: StorePlatform = {
  documentsDir: () => join(homedir(), 'Documents'),
  appVersion: () => process.env.npm_package_version ?? '0.0.0',
  encryptSecret: () => null,
  decryptSecret: () => null,
};
