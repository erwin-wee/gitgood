import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The client a handler call belongs to. The server runs each invoke inside
 * `clientContext.run(clientId, …)` so per-client state (open repository
 * watcher, in-flight history load) is not shared between a desktop and a phone
 * on the same repository. The desktop app never sets it: it is the single '' client.
 */
export const clientContext = new AsyncLocalStorage<string>();

export function currentClient(): string {
  return clientContext.getStore() ?? '';
}
