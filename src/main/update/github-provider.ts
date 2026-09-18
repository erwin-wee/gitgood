/**
 * Dependency-free GitHub Releases provider (the fallback documented in the
 * change's design.md, pending the `electron-updater` dependency review).
 * Two ways to reach the API: the signed-in `gh` CLI (authenticated, so it is
 * not subject to GitHub's low unauthenticated rate limit) or a plain HTTPS
 * request. Both hit the single "latest release" endpoint, matching GitHub's
 * definition of "latest" (never a prerelease or a draft); see the note on
 * DynamicUpdateProvider for what that means for the beta channel.
 */
import { GitError } from '../git/git';
import type { GhClient } from '../gh/gh';
import { log } from '../logger';
import type { ToolLocator } from '../tools';
import type { ReleaseInfo } from './update-core';
import type { UpdateProvider } from './provider';

const RELEASE_PATH = 'repos/erwin-wee/gitgood/releases/latest';
const RELEASE_API_URL = 'https://api.github.com/repos/erwin-wee/gitgood/releases/latest';

interface RawRelease {
  tag_name?: string;
  html_url?: string;
  body?: string | null;
  published_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
}

/** Strips a leading "v"/"V" from a tag name, e.g. "v1.2.3" -> "1.2.3". */
export function normalizeVersion(tagName: string): string {
  return tagName.trim().replace(/^v/i, '');
}

/** Maps the GitHub REST "release" shape to ReleaseInfo. Pure so it can be unit tested against canned JSON without spawning `gh` or the network. */
export function parseRelease(raw: RawRelease | null | undefined): ReleaseInfo | null {
  if (!raw || !raw.tag_name) return null;
  return {
    version: normalizeVersion(raw.tag_name),
    releaseDate: raw.published_at ?? null,
    notes: raw.body?.trim() || null,
    url: raw.html_url ?? `https://github.com/erwin-wee/gitgood/releases/tag/${encodeURIComponent(raw.tag_name)}`,
    prerelease: !!raw.prerelease,
    draft: !!raw.draft,
  };
}

/** Fetches the latest release via the signed-in `gh` CLI (`gh api repos/erwin-wee/gitgood/releases/latest`). */
export class GhCliReleaseProvider implements UpdateProvider {
  readonly name = 'gh-cli';
  constructor(private readonly gh: GhClient) {}

  async fetchLatestRelease(): Promise<ReleaseInfo | null> {
    try {
      const raw = await this.gh.json<RawRelease>(['api', RELEASE_PATH], { timeoutMs: 30000 });
      return parseRelease(raw);
    } catch (err) {
      if (err instanceof GitError && (err.info.code === 'remote-not-found' || /HTTP 404/i.test(err.info.stderr))) return null;
      throw err;
    }
  }
}

/** A `fetch`-shaped function, injected so tests never touch the real network. Matches enough of the WHATWG Response for our needs. */
export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Fetches the latest release with a plain HTTPS request (used when the user is not signed in to `gh`), via an injected fetcher so tests never touch the network. */
export class FetchReleaseProvider implements UpdateProvider {
  readonly name = 'fetch';
  constructor(private readonly fetcher: Fetcher, private readonly userAgent: string) {}

  async fetchLatestRelease(): Promise<ReleaseInfo | null> {
    const res = await this.fetcher(RELEASE_API_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': this.userAgent } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} while checking for updates.`);
    return parseRelease((await res.json()) as RawRelease);
  }
}

/**
 * Picks the `gh`-based provider when the user is signed in (avoiding the
 * unauthenticated API's low rate limit) and falls back to a plain request
 * otherwise, re-checking on every call so a sign-in/out mid-run is honoured
 * immediately. Deliberately only ever calls the "latest release" endpoint,
 * per this change's scope decision — GitHub defines that endpoint to never
 * return a prerelease or a draft, so on the beta channel this fallback can
 * offer a newer *stable* release but cannot detect a beta-only prerelease;
 * a real `electron-updater`-backed provider (once approved) would use the
 * full releases list instead.
 */
export class DynamicUpdateProvider implements UpdateProvider {
  readonly name = 'github-fallback';
  private readonly ghProvider: GhCliReleaseProvider;
  private readonly fetchProvider: FetchReleaseProvider;

  constructor(gh: GhClient, private readonly tools: ToolLocator, fetcher: Fetcher, userAgent: string) {
    this.ghProvider = new GhCliReleaseProvider(gh);
    this.fetchProvider = new FetchReleaseProvider(fetcher, userAgent);
  }

  async fetchLatestRelease(): Promise<ReleaseInfo | null> {
    const state = this.tools.current();
    if (state.ghAccount && state.gh.installed) {
      try {
        return await this.ghProvider.fetchLatestRelease();
      } catch (err) {
        log.warn(`gh-based update check failed, falling back to a direct request: ${(err as Error).message}`);
      }
    }
    return this.fetchProvider.fetchLatestRelease();
  }
}
