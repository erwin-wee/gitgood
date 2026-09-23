import { isAbsolute } from 'node:path';

const MUTATING_LEAF = /^(apply|undo|create|clone|remove|delete|deleteRemote|deleteMany|merge|rebase|revert|squash|reorder|reword|drop|import|sync|publish|fork|run|pop|push|pull|stage|unstage|checkout|checkoutCommit|checkoutRemoteBranch|prune|gc|expire|install|track|set|setState|setIdentity|unsetLocalIdentity|setAlias|setLfsTracking|write|writeFile|add|insert|markResolved|useSide|useSideForBlock|unresolve|trustConfig|post|dismiss|applySuggestion|comment|review|ready|close|reopen|login|logout|setupGit|refreshScopes|cancelLogin|enable|disable|upload|download|setApiKey|moveToTrash|removeLockFile|resolve|resolveAll|resolveAllGuided|clearExamples|start|startWorktree)$/;

/** Whether a method changes state (git ops, writes, AI applies). Matches on the leaf segment so `repo.commit.details` (a read) is not mistaken for `git.commit`. */
export function isMutating(method: string): boolean {
  if (method.startsWith('git.')) return true;
  return MUTATING_LEAF.test(method.slice(method.lastIndexOf('.') + 1));
}

/** The serialization key for a mutating call: its target repository path, or the method name when it takes none. */
export function mutationKey(method: string, args: unknown[]): string {
  const repoArg = args.find((a): a is string => typeof a === 'string' && isAbsolute(a));
  return repoArg ?? method;
}

/**
 * Serializes async work per key so two clients cannot run overlapping mutations
 * on the same repository (which would race git's index/lock files). Different
 * repositories still run concurrently.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.tails.set(
      key,
      prev.then(() => promise),
    );
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

/**
 * Per-client token-bucket rate limiter for the invoke boundary: `capacity`
 * burst, refilling `refillPerSec` tokens each second. Returns false when a
 * caller has spent its budget so the server can answer 429.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, last: t };
    const elapsed = (t - bucket.last) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSec);
    bucket.last = t;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

/** A single audit-trail line for a mutating invoke, for the server log. */
export function auditLine(clientId: string, method: string, key: string, ok: boolean): string {
  return `[audit] client=${clientId || '-'} method=${method} target=${key} outcome=${ok ? 'ok' : 'error'}`;
}
