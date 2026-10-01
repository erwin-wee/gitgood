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

const controllerOwners = new WeakMap<AbortController, string>();

/** An AbortController tagged with the client that started the job, so `cancelOwned` can leave other clients' jobs alone. */
export function ownedController(): AbortController {
  const controller = new AbortController();
  controllerOwners.set(controller, currentClient());
  return controller;
}

/** Aborts `controller` if the calling client started it; returns whether it did. */
export function cancelOwned(controller: AbortController | null): boolean {
  if (!controller || controllerOwners.get(controller) !== currentClient()) return false;
  controller.abort();
  return true;
}
