import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Submodule, SubmoduleState } from '@shared/types';
import type { ProgressSink } from './operations';
import { TransferProgressParser, type GitClient } from './git';

export interface SubmoduleStatusEntry {
  /** `git submodule status` line prefix: ' ' up to date, '-' uninitialized, '+' differs, 'U' conflicted. */
  prefix: ' ' | '-' | '+' | 'U';
  sha: string;
  path: string;
  /** Parenthesised `git describe` suffix, when present. */
  describe: string | null;
}

/**
 * Parses `git submodule status --recursive` output. Each line looks like
 * `<prefix><sha> <path> (<describe>)`, with the describe suffix omitted for
 * uninitialized submodules and always present for the rest when the
 * submodule has tags to describe from.
 */
export function parseSubmoduleStatus(output: string): SubmoduleStatusEntry[] {
  const entries: SubmoduleStatusEntry[] = [];
  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const prefixChar = rawLine[0];
    const prefix: SubmoduleStatusEntry['prefix'] = prefixChar === '-' || prefixChar === '+' || prefixChar === 'U' ? prefixChar : ' ';
    const rest = (prefix === ' ' ? rawLine : rawLine.slice(1)).trim();
    const m = /^(\S+)\s+(.+?)(?:\s+\(([^)]*)\))?$/.exec(rest);
    if (!m) continue;
    entries.push({ prefix, sha: m[1], path: m[2], describe: m[3] ?? null });
  }
  return entries;
}

export interface SubmoduleConfigEntry {
  name: string;
  path: string;
  url: string;
  branch: string | null;
}

/**
 * Parses `git config --file .gitmodules --list -z` output: NUL-separated
 * entries, each `key\nvalue` (the newline separator is what `-z` uses
 * between a multi-line-safe key and value).
 */
export function parseGitmodulesConfig(output: string): SubmoduleConfigEntry[] {
  const byName = new Map<string, SubmoduleConfigEntry>();
  for (const entry of output.split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    const key = entry.slice(0, nl);
    const value = entry.slice(nl + 1);
    const m = /^submodule\.(.+)\.(path|url|branch)$/.exec(key);
    if (!m) continue;
    const [, name, field] = m;
    const cur = byName.get(name) ?? { name, path: '', url: '', branch: null };
    if (field === 'path') cur.path = value;
    else if (field === 'url') cur.url = value;
    else cur.branch = value;
    byName.set(name, cur);
  }
  return [...byName.values()];
}

/**
 * Resolves a relative submodule URL (`./x`, `../x`) against the
 * superproject's origin URL, matching git's own algorithm: the origin URL is
 * treated as a stack of path segments (including its last component), and
 * the relative URL's own segments are applied against that stack (`..` pops,
 * anything else pushes). Absolute URLs, and relative ones with no origin to
 * resolve against, are returned unchanged.
 */
export function resolveSubmoduleUrl(url: string, originUrl: string | null): string {
  if (!originUrl || !/^\.\.?(\/|$)/.test(url)) return url;
  const parts = originUrl.replace(/\/+$/, '').split('/');
  for (const seg of url.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

async function buildSubmodule(git: GitClient, repoPath: string, entry: SubmoduleStatusEntry, config: SubmoduleConfigEntry | null, originUrl: string | null, rootPaths: Set<string>): Promise<Submodule> {
  const path = entry.path;
  const nested = !rootPaths.has(path);
  const recordedOut = await git.tryRun(repoPath, ['ls-tree', 'HEAD', '--', path], { readOnly: true });
  const recordedMatch = recordedOut ? /^\d+\s+\S+\s+([0-9a-f]{40})\s/.exec(recordedOut.stdout) : null;
  const recordedSha = recordedMatch?.[1] ?? entry.sha ?? null;

  let state: SubmoduleState;
  let checkedOutSha: string | null = null;
  if (entry.prefix === '-') {
    state = 'uninitialized';
  } else {
    checkedOutSha = entry.sha;
    if (entry.prefix === 'U') state = 'conflicted';
    else if (entry.prefix === '+') state = 'differs';
    else {
      const fullPath = join(repoPath, ...path.split('/'));
      const dirty = existsSync(fullPath) ? await git.tryRun(fullPath, ['status', '--porcelain', '--ignore-submodules=all'], { readOnly: true }) : null;
      state = dirty && dirty.stdout.trim() ? 'modified' : 'up-to-date';
    }
  }

  return {
    path,
    name: config?.name ?? path,
    url: resolveSubmoduleUrl(config?.url ?? '', originUrl),
    recordedSha,
    checkedOutSha,
    state,
    nested,
  };
}

/**
 * Full submodule listing: `git submodule status --recursive` for state,
 * cross-referenced with `.gitmodules` for name/url, including submodules
 * discovered only recursively (nested inside another submodule) and
 * submodules declared in `.gitmodules` but missing from the index entirely.
 */
export async function getSubmodules(git: GitClient, repoPath: string, originUrl: string | null): Promise<Submodule[]> {
  const [statusOut, configOut] = await Promise.all([
    git.tryRun(repoPath, ['submodule', 'status', '--recursive'], { readOnly: true }),
    git.tryRun(repoPath, ['config', '--file', '.gitmodules', '--list', '-z'], { readOnly: true }),
  ]);
  const entries = statusOut ? parseSubmoduleStatus(statusOut.stdout) : [];
  const configs = configOut ? parseGitmodulesConfig(configOut.stdout) : [];
  const configByPath = new Map(configs.map((c) => [c.path, c]));
  const entryByPath = new Map(entries.map((e) => [e.path, e]));
  const rootPaths = new Set(configs.map((c) => c.path));

  const results: Submodule[] = [];
  for (const config of configs) {
    const entry = entryByPath.get(config.path);
    if (!entry) {
      results.push({ path: config.path, name: config.name, url: resolveSubmoduleUrl(config.url, originUrl), recordedSha: null, checkedOutSha: null, state: 'missing', nested: false });
      continue;
    }
    results.push(await buildSubmodule(git, repoPath, entry, config, originUrl, rootPaths));
  }
  for (const entry of entries) {
    if (configByPath.has(entry.path)) continue;
    results.push(await buildSubmodule(git, repoPath, entry, null, originUrl, rootPaths));
  }
  results.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return results;
}

/** True when the repository has a `.gitmodules` file with at least one uninitialized submodule (for the post-clone banner). */
export async function hasUninitializedSubmodules(git: GitClient, repoPath: string): Promise<boolean> {
  if (!existsSync(join(repoPath, '.gitmodules'))) return false;
  const out = await git.tryRun(repoPath, ['submodule', 'status', '--recursive'], { readOnly: true });
  if (!out) return false;
  return parseSubmoduleStatus(out.stdout).some((e) => e.prefix === '-');
}

export async function updateSubmodules(git: GitClient, repoPath: string, paths: string[] | null, init: boolean, onProgress: ProgressSink, signal?: AbortSignal): Promise<void> {
  const parser = new TransferProgressParser('fetch');
  const args = ['submodule', 'update', '--recursive', '--progress'];
  if (init) args.push('--init');
  if (paths && paths.length) args.push('--', ...paths);
  await git.run(repoPath, args, {
    signal,
    onStderr: (chunk) => {
      const p = parser.feed(chunk);
      if (p) onProgress(p.percent, p.description);
    },
    timeoutMs: 30 * 60 * 1000,
  });
}

export async function syncSubmodules(git: GitClient, repoPath: string): Promise<void> {
  await git.run(repoPath, ['submodule', 'sync', '--recursive']);
}
