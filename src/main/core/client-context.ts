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

/**
 * The outstanding jobs of one AI feature, each tagged with the client that started it, so one client's
 * start/cancel never touches another client's job. A job stays listed until its own `end` (call it from
 * `finally`), so `isActive` also covers a job that was aborted but has not unwound yet.
 */
export class ClientJobs {
  private readonly jobs = new Map<AbortController, string>();

  /** Starts the calling client's job; its earlier job of this feature is aborted (replaced). Read `signal` from the returned controller, never from shared state. */
  start(): AbortController {
    this.cancel();
    const job = new AbortController();
    this.jobs.set(job, currentClient());
    return job;
  }

  /** Aborts the calling client's jobs. */
  cancel(): void {
    const client = currentClient();
    for (const [job, owner] of this.jobs) if (owner === client) job.abort();
  }

  /** Forgets a finished job. */
  end(job: AbortController): void {
    this.jobs.delete(job);
  }

  /** True while any client's job (including an aborted one still unwinding) is outstanding. */
  isActive(): boolean {
    return this.jobs.size > 0;
  }
}
