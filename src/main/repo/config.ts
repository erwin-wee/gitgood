import { log } from '../logger';
import { readRepoFile } from './paths';

export interface RepoConfig {
  /** Shell command from `.gitgood/config.json`'s `postResolveCheck` field, or null when absent/invalid. */
  postResolveCheck: string | null;
  /** False only when the file says `"ai": false`: AI is switched off for this repository for everyone who clones it. */
  ai: boolean;
}

const EMPTY_REPO_CONFIG: RepoConfig = { postResolveCheck: null, ai: true };

/**
 * Reads and validates `.gitgood/config.json` at the repository root. This
 * never runs the command it reports and never gates on trust: it is a pure
 * read used both by the trust-confirmation flow and by the resolver, which
 * itself decides (via the store's `trustedRepoConfigs`) whether the returned
 * command may actually be run. Missing file, symlink (or one leaving the repository), unreadable file or malformed
 * JSON all resolve to the empty config rather than throwing.
 */
export async function readRepoConfig(repoPath: string): Promise<RepoConfig> {
  const file = '.gitgood/config.json';
  const text = (await readRepoFile(repoPath, file))?.toString('utf8');
  if (text === undefined) return EMPTY_REPO_CONFIG;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parseRepoConfig(parsed);
  } catch (err) {
    log.warn(`Could not parse ${file}: ${(err as Error).message}`);
    return EMPTY_REPO_CONFIG;
  }
}

/** Pure validation, split out for unit testing without touching the filesystem. */
export function parseRepoConfig(raw: unknown): RepoConfig {
  if (!raw || typeof raw !== 'object') return EMPTY_REPO_CONFIG;
  const { postResolveCheck: command, ai } = raw as { postResolveCheck?: unknown; ai?: unknown };
  return { postResolveCheck: typeof command === 'string' && command.trim() ? command : null, ai: ai !== false };
}
