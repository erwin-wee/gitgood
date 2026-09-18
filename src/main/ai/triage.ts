import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiSettings, AiTriageProgressEvent, GitHubRepoRef, PrTriage, PullRequest } from '@shared/types';
import { GitError } from '../git/git';
import type { GhClient } from '../gh/gh';
import { log } from '../logger';
import type { RepositoryManager } from '../repo/manager';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError, type AiBackend } from './backends';
import { buildTriagePrompt, TRIAGE_SCHEMA, TRIAGE_SYSTEM_PROMPT, type TriagePromptPr } from './prompts';
import { createBackend } from './provider';
import { stableHash } from './review-core';
import { BATCH_SIZE, evictTriageCache, splitBatches, validateTriageBatch, type TriageBatchResult } from './triage-core';

const MAX_FILE_STATS = 50;

/**
 * AI pull request triage: batches the pull requests a caller asks about,
 * sends each batch's metadata (never a diff) to the model, cross-checks the
 * result against the deterministic rules in triage-core.ts, and persists the
 * result per repository so repeat opens are free until a pull request's
 * `updatedAt` changes. See review.ts for the sibling orchestration pattern.
 */
export class TriageService {
  private controller: AbortController | null = null;

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly gh: GhClient, private readonly repos: RepositoryManager, private readonly userDataDir: string) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a triage run is in flight; used by the update install gate to refuse installing mid-run. */
  isActive(): boolean {
    return this.controller !== null;
  }

  // ---------- storage ----------

  private cacheFile(repoPath: string): string {
    const id = this.repos.getByPath(repoPath)?.id ?? stableHash(repoPath);
    return join(this.userDataDir, 'triage', `${id.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
  }

  private async loadCache(repoPath: string): Promise<Record<number, PrTriage>> {
    const file = this.cacheFile(repoPath);
    if (!existsSync(file)) return {};
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      return raw && typeof raw === 'object' ? (raw as Record<number, PrTriage>) : {};
    } catch (err) {
      log.warn(`Could not read the triage cache for ${repoPath}: ${(err as Error).message}`);
      return {};
    }
  }

  private async saveCache(repoPath: string, cache: Record<number, PrTriage>): Promise<void> {
    const file = this.cacheFile(repoPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(cache, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
  }

  /** Cached triage lines for a repository, with entries older than 30 days already dropped. Never calls gh: closed/merged eviction only happens on the next `run` (see design.md decision 4). */
  async get(repoPath: string): Promise<Record<number, PrTriage>> {
    const cache = await this.loadCache(repoPath);
    return evictTriageCache(cache, new Set(Object.keys(cache).map(Number)), Date.now());
  }

  async clear(repoPath: string): Promise<void> {
    await this.saveCache(repoPath, {});
  }

  // ---------- running ----------

  private isFatal(err: unknown): boolean {
    return err instanceof AiError && (err.kind === 'auth' || err.kind === 'not-configured' || err.kind === 'rate-limit');
  }

  private async promptPr(ref: GitHubRepoRef, pr: PullRequest, includeDiffStat: boolean, now: number): Promise<TriagePromptPr> {
    let failingChecks: string[] = [];
    if (pr.checks.state === 'failure') {
      try {
        failingChecks = (await this.gh.prChecks(ref, pr.number)).filter((c) => c.bucket === 'fail').map((c) => (c.workflow ? `${c.workflow} / ${c.name}` : c.name));
      } catch (err) {
        log.warn(`Could not read checks for pull request #${pr.number}: ${(err as Error).message}`);
      }
    }
    const updated = Date.parse(pr.updatedAt);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body.slice(0, 1500),
      author: pr.author,
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRepo: pr.isCrossRepository ? pr.headRepo : null,
      labels: pr.labels,
      reviewDecision: pr.reviewDecision,
      reviewRequests: pr.reviewRequests,
      latestReviews: pr.latestReviews,
      checksSummary: pr.checks.total ? `${pr.checks.passed}/${pr.checks.total} passed` : 'no checks reported',
      failingChecks,
      mergeable: pr.mergeable,
      updatedAt: pr.updatedAt,
      ageDays: Number.isNaN(updated) ? 0 : Math.max(0, Math.floor((now - updated) / (24 * 60 * 60 * 1000))),
      fileStats: includeDiffStat ? pr.filesChanged.slice(0, MAX_FILE_STATS) : null,
    };
  }

  private async runBatch(ref: GitHubRepoRef, prs: PullRequest[], login: string | null, includeDiffStat: boolean, settings: AiSettings, backend: AiBackend, signal: AbortSignal): Promise<TriageBatchResult> {
    const now = Date.now();
    const promptPrs = await Promise.all(prs.map((pr) => this.promptPr(ref, pr, includeDiffStat, now)));
    const generatedAt = new Date().toISOString();
    const response = await backend.complete({
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(promptPrs, login),
      schema: TRIAGE_SCHEMA as unknown as Record<string, unknown>,
      model: settings.model,
      effort: settings.effort === 'max' ? 'high' : settings.effort,
      signal,
    });
    return validateTriageBatch(response.json, prs, login, now, response.model, generatedAt);
  }

  /**
   * Requests fresh triage lines for `numbers` (open pull requests lacking a
   * fresh cache entry, as determined by the caller), in batches of at most
   * BATCH_SIZE. Cancellation between batches keeps whatever completed;
   * numbers missing from a batch response are retried once individually.
   * Returns the full, updated cache for the repository.
   */
  async run(repoPath: string, numbers: number[], report: (e: AiTriageProgressEvent) => void): Promise<Record<number, PrTriage>> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      const { backend, settings } = await createBackend(this.store, this.tools);
      const ref = await this.repos.detectGitHub(repoPath);
      if (!ref) throw new GitError({ message: 'This repository does not have a GitHub remote.', command: '', exitCode: null, stderr: '', stdout: '', code: 'remote-not-found' });

      const openPrs = await this.gh.prList(ref, 'open');
      const byNumber = new Map(openPrs.map((pr) => [pr.number, pr]));
      const openNumbers = new Set(openPrs.map((pr) => pr.number));
      let cache = evictTriageCache(await this.loadCache(repoPath), openNumbers, Date.now());
      const login = await this.gh.viewerLogin();

      const wanted = numbers.filter((n) => byNumber.has(n));
      const batches = splitBatches(wanted, BATCH_SIZE);
      const total = wanted.length;
      let done = 0;
      report({ repoPath, done, total });

      for (const batch of batches) {
        if (signal.aborted) break;
        const batchPrs = batch.map((n) => byNumber.get(n)!);
        try {
          const { entries, missingNumbers } = await this.runBatch(ref, batchPrs, login, settings.triageIncludeDiffStat, settings, backend, signal);
          for (const entry of entries) cache[entry.number] = entry;
          for (const n of missingNumbers) {
            if (signal.aborted) break;
            const single = byNumber.get(n);
            if (!single) continue;
            try {
              const retry = await this.runBatch(ref, [single], login, settings.triageIncludeDiffStat, settings, backend, signal);
              for (const entry of retry.entries) cache[entry.number] = entry;
              if (retry.missingNumbers.length) log.warn(`Pull request #${n} was not summarized after a retry.`);
            } catch (err) {
              if (this.isFatal(err)) throw err;
              if (!signal.aborted) log.warn(`Retry for pull request #${n} failed: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          if (this.isFatal(err)) throw err;
          if (!signal.aborted) log.warn(`A triage batch failed and was skipped, keeping existing cached lines: ${(err as Error).message}`);
        }
        done += batch.length;
        cache = evictTriageCache(cache, openNumbers, Date.now());
        await this.saveCache(repoPath, cache);
        report({ repoPath, done: Math.min(done, total), total });
      }
      log.info(`AI triage for ${repoPath}: ${wanted.length} pull request(s) requested via ${backend.name}/${settings.model}`);
      return cache;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
