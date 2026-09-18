import type { ReleaseNotes, ReleaseNotesInput, ReleaseRangeQuery, ReleaseRangeResult, ReleasePr } from '@shared/types';
import { getLatestReachableTag } from '../git/operations';
import { getReleaseDiffStat, getReleaseLog } from '../git/log';
import type { GitClient } from '../git/git';
import type { GhClient } from '../gh/gh';
import { log } from '../logger';
import type { RepositoryManager } from '../repo/manager';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { buildReleaseNotes, collectPrNumbers } from './release-notes-core';
import { buildReleaseNotesPrompt, RELEASE_NOTES_SCHEMA, releaseNotesSystemPrompt, type ReleaseNotesPromptCommit, type ReleaseNotesPromptPr } from './prompts';
import { createBackend } from './provider';

/** Pull request numbers beyond this many in one range are not looked up (spec: "capped at 100"). */
const MAX_PR_LOOKUPS = 100;
const PR_LOOKUP_CONCURRENCY = 4;

export type ReleaseNotesProgressPhase = 'started' | 'thinking' | 'writing' | 'done' | 'error';
export type ReleaseNotesReporter = (phase: ReleaseNotesProgressPhase, message: string) => void;

/** Runs `fn` over `items` with at most `concurrency` in flight at once, preserving no particular order in the returned array's population (order of `items` is preserved in the result). */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Gathers, for AI release notes, the commits and pull requests in a range,
 * and drafts categorized, reference-checked notes from them (see
 * release-notes-core.ts for the validation/assembly, which is pure and
 * unit-tested independently). Never runs a write of its own: changelog
 * insertion and release creation are separate, explicitly user-confirmed
 * actions (see repo.changelog.insert and GhClient.releaseCreate).
 */
export class ReleaseNotesService {
  private controller: AbortController | null = null;

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient, private readonly gh: GhClient, private readonly repos: RepositoryManager) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a generation is in flight; used by the update install gate to refuse installing mid-generation. */
  isActive(): boolean {
    return this.controller !== null;
  }

  /** Pull request numbers referenced in a range, fetched (title/labels/author/url) up to MAX_PR_LOOKUPS with PR_LOOKUP_CONCURRENCY in flight; empty when `includePrs` is off, there is no GitHub remote, or the user is not signed in. */
  private async fetchPrs(repoPath: string, prNumbers: number[], includePrs: boolean): Promise<ReleasePr[]> {
    if (!includePrs || !prNumbers.length || !this.tools.current().ghAccount) return [];
    const ref = await this.repos.detectGitHub(repoPath);
    if (!ref) return [];
    const toFetch = prNumbers.slice(0, MAX_PR_LOOKUPS);
    const fetched = await mapWithConcurrency(toFetch, PR_LOOKUP_CONCURRENCY, async (number): Promise<ReleasePr | null> => {
      try {
        const pr = await this.gh.prView(ref, number);
        return { number, title: pr.title, labels: pr.labels, author: pr.author, url: pr.url };
      } catch (err) {
        log.warn(`Could not fetch pull request #${number} for release notes: ${(err as Error).message}`);
        return null;
      }
    });
    return fetched.filter((p): p is ReleasePr => p !== null);
  }

  /** Range preview for the Release notes dialog: commits, referenced pull requests, the latest reachable tag and the diff stat. */
  async range(repoPath: string, query: ReleaseRangeQuery): Promise<ReleaseRangeResult> {
    const latestTag = await getLatestReachableTag(this.git, repoPath);
    const rootFallback = query.from === null && !latestTag;
    const from = query.from !== null ? query.from : latestTag;
    const [{ commits, mergeSubjects, truncated }, diffStat] = await Promise.all([getReleaseLog(this.git, repoPath, from, query.to), getReleaseDiffStat(this.git, repoPath, from, query.to)]);
    const prNumbers = collectPrNumbers(mergeSubjects, commits.map((c) => c.subject));
    const prs = await this.fetchPrs(repoPath, prNumbers, query.includePrs);
    return { range: { from, to: query.to }, commits, prs, latestTag, rootFallback, truncated, diffStat };
  }

  async generate(repoPath: string, input: ReleaseNotesInput, report: ReleaseNotesReporter): Promise<ReleaseNotes> {
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      report('started', 'Reading commits…');
      const { backend, settings } = await createBackend(this.store, this.tools);

      const { commits, mergeSubjects, truncated } = await getReleaseLog(this.git, repoPath, input.range.from, input.range.to);
      if (!commits.length) throw new AiError('There are no commits in this range to generate notes from.', 'other');
      const diffStat = await getReleaseDiffStat(this.git, repoPath, input.range.from, input.range.to);
      const prNumbers = collectPrNumbers(mergeSubjects, commits.map((c) => c.subject));
      const prs = await this.fetchPrs(repoPath, prNumbers, input.includePrs);
      const prTitles = new Map(prs.map((p) => [p.number, p.title]));

      report('thinking', `Drafting with ${settings.model}…`);
      const promptCommits: ReleaseNotesPromptCommit[] = commits.map((c) => ({ sha: c.sha, subject: c.subject, body: c.body, prNumber: c.prNumber }));
      const promptPrs: ReleaseNotesPromptPr[] = prs.map((p) => ({ number: p.number, title: p.title, labels: p.labels }));
      const response = await backend.complete({
        system: releaseNotesSystemPrompt(input.audience),
        prompt: buildReleaseNotesPrompt({
          version: input.version,
          audience: input.audience,
          fromLabel: input.range.from ?? 'the root commit',
          toLabel: input.range.to,
          commits: promptCommits,
          prs: promptPrs,
          diffStat,
          truncated,
        }),
        schema: RELEASE_NOTES_SCHEMA as unknown as Record<string, unknown>,
        model: settings.model,
        effort: settings.effort,
        signal,
        onProgress: (m) => report('writing', m),
      });

      const date = new Date().toISOString().slice(0, 10);
      const notes = buildReleaseNotes(response.json, { version: input.version, date, commits, prNumbers, prTitles, truncated, model: response.model });
      report('done', 'Release notes ready');
      log.info(`AI release notes for ${repoPath} (${input.range.from ?? 'root'}..${input.range.to}): ${notes.sections.reduce((n, s) => n + s.items.length, 0)} item(s), ${notes.unreferenced.length} unreferenced, via ${backend.name}/${response.model}`);
      return notes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!signal.aborted) report('error', message);
      throw err;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
