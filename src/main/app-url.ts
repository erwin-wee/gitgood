import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The one document the app window may show: the configured server (client mode), the dev server, or the packaged renderer entry. */
export function appEntryUrl(remoteUrl?: string): string {
  return remoteUrl ?? process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}

/** True when `url` is exactly the `entry` document (query/hash ignored): same origin and path for http(s), same file for file://. Any other file:// URL is rejected. */
export function isEntryUrl(url: string | undefined | null, entry: string): boolean {
  if (!url) return false;
  try {
    const a = new URL(url);
    const b = new URL(entry);
    if (a.protocol !== b.protocol) return false;
    if (a.protocol === 'file:') return fileURLToPath(a) === fileURLToPath(b);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/** IPC is served only to the app's own top-level frame: not a subframe, not another document. */
export function isTrustedSender(event: { sender: { mainFrame: unknown }; senderFrame?: { url: string } | null }, entry: string): boolean {
  return !!event.senderFrame && event.senderFrame === event.sender.mainFrame && isEntryUrl(event.senderFrame.url, entry);
}
