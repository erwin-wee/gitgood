import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../logger';

export interface RepoConfig {
  /** Shell command from `.gitgood/config.json`'s `postResolveCheck` field, or null when absent/invalid. */
  postResolveCheck: string | null;
}

const EMPTY_REPO_CONFIG: RepoConfig = { postResolveCheck: null };

/**
 * Reads and validates `.gitgood/config.json` at the repository root. This
 * never runs the command it reports and never gates on trust: it is a pure
 * read used both by the trust-confirmation flow and by the resolver, which
 * itself decides (via the store's `trustedRepoConfigs`) whether the returned
 * command may actually be run. Missing file, unreadable file or malformed
 * JSON all resolve to the empty config rather than throwing.
 */
export async function readRepoConfig(repoPath: string): Promise<RepoConfig> {
  const file = join(repoPath, '.gitgood', 'config.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return EMPTY_REPO_CONFIG;
  }
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
  const command = (raw as { postResolveCheck?: unknown }).postResolveCheck;
  return { postResolveCheck: typeof command === 'string' && command.trim() ? command : null };
}
