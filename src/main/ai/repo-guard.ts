import { AiError } from './backends';

/**
 * `ai.*` methods that are never blocked: rollbacks of something already applied (a later opt-out must not
 * strand the user) and `ai.cancel`, whose first argument is a feature name, not a repository path.
 */
const UNGUARDED_METHODS = new Set(['ai.split.undo', 'ai.rebase.undo', 'ai.resolve.useSideForBlock', 'ai.cancel']);

type AnyHandler = (...args: unknown[]) => Promise<unknown>;

/**
 * Wraps, in place, every `ai.*` handler whose first argument is a repository path so it throws an
 * AiError while AI is switched off for that repository (`blockedReason` returns the message), before
 * any service code runs. One chokepoint: a new `ai.*` method is covered without remembering to guard it.
 */
export function guardAiHandlers(handlers: Record<string, AnyHandler>, blockedReason: (repoPath: string) => Promise<string | null>): void {
  for (const [method, inner] of Object.entries(handlers)) {
    if (!method.startsWith('ai.') || UNGUARDED_METHODS.has(method)) continue;
    handlers[method] = async (...args) => {
      const repoPath = args[0];
      const reason = typeof repoPath === 'string' ? await blockedReason(repoPath) : null;
      if (reason) throw new AiError(reason, 'other');
      return inner(...args);
    };
  }
}
