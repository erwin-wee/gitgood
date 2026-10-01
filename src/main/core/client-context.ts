import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';

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

/**
 * The repository (path) whose handler call is running, so gh/git calls made deep inside services use
 * that repository's chosen GitHub account (see `ToolLocator.repoAccount`).
 */
export const repoScope = new AsyncLocalStorage<string>();

/** Wraps, in place, every handler whose first argument is an absolute path so it runs inside `repoScope`. */
export function scopeRepoHandlers(handlers: Record<string, (...args: unknown[]) => Promise<unknown>>): void {
  for (const [method, inner] of Object.entries(handlers)) {
    handlers[method] = (...args) => (typeof args[0] === 'string' && isAbsolute(args[0]) ? repoScope.run(args[0], () => inner(...args)) : inner(...args));
  }
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
