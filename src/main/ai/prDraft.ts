import type { PrDraft, PrDraftInput } from '@shared/types';
import { getRangePatch } from '../git/diff';
import { GitError, type GitClient } from '../git/git';
import { compareRefs, mergeBase } from '../git/log';
import { findPullRequestTemplate } from '../gh/pr-template';
import type { GhClient } from '../gh/gh';
import { log } from '../logger';
import type { RepositoryManager } from '../repo/manager';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import {
  capBody,
  downgradeUnallowedClosings,
  collectIssueReferences,
  detectLineEnding,
  extractTemplateHeadings,
  headingsPresentInOrder,
  normalizePrTitle,
  reconcileLinkedIssues,
  restoreCheckboxes,
  restoreTemplateStructure,
  templateCheckboxLabels,
} from './pr-draft-core';
import { buildPrDraftPrompt, PR_DRAFT_SCHEMA, PR_DRAFT_SYSTEM_PROMPT, type PrDraftPromptCommit, type PrDraftPromptIssue } from './prompts';
import { createBackend } from './provider';
import { stripFences } from './review-core';

const MAX_DIFF_BYTES = 120_000;
const MAX_COMMITS = 100;
const SUBJECTS_ONLY_THRESHOLD = 400;
const MAX_TEMPLATE_CHARS = 6_000;
const MAX_ISSUES_FETCHED = 5;

export type PrDraftProgressPhase = 'started' | 'thinking' | 'writing' | 'done' | 'error';
export type PrDraftReporter = (phase: PrDraftProgressPhase, message: string) => void;

/**
 * Drafts a pull request title and body from the commits and diff ahead of a
 * base branch, plus the repository's PR template when it has one. Gathers
 * everything the model needs in the main process, validates and repairs its
 * output against the real template and issue references before returning it
 * (see pr-draft-core.ts), and never creates the pull request itself.
 */
export class PrDraftService {
  private controller: AbortController | null = null;

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient, private readonly gh: GhClient, private readonly repos: RepositoryManager) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a draft is in flight; used by the update install gate to refuse installing mid-draft. */
  isActive(): boolean {
    return this.controller !== null;
  }

  private async resolveBaseRef(repoPath: string, base: string): Promise<string | null> {
    if (await this.git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { readOnly: true })) return base;
    if (await this.git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`], { readOnly: true })) return `origin/${base}`;
    return null;
  }

  async draft(repoPath: string, input: PrDraftInput, report: PrDraftReporter): Promise<PrDraft> {
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      report('started', 'Reading commits and diff…');
      const { backend, settings } = await createBackend(this.store, this.tools);

      const baseRef = await this.resolveBaseRef(repoPath, input.base);
      if (!baseRef) throw new GitError({ message: `Base branch "${input.base}" was not found locally. Fetch first.`, command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
      const headSha = (await this.git.stdout(repoPath, ['rev-parse', input.head], { readOnly: true, signal })).trim();

      const mb = await mergeBase(this.git, repoPath, baseRef, headSha);
      if (!mb) throw new GitError({ message: 'The base and head branches share no common history.', command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });

      const totalAhead = parseInt((await this.git.stdout(repoPath, ['rev-list', '--count', `${mb}..${headSha}`], { readOnly: true, signal })).trim(), 10) || 0;
      if (totalAhead === 0) throw new AiError('There are no commits ahead of the base branch to draft from.', 'other');

      const { ahead } = await compareRefs(this.git, repoPath, mb, headSha);
      const capped = ahead.slice(0, MAX_COMMITS);
      const subjectsOnly = totalAhead > SUBJECTS_ONLY_THRESHOLD;
      const commits: PrDraftPromptCommit[] = capped.map((c) => ({ summary: c.summary, body: subjectsOnly ? null : c.body || null }));

      const { stat, patch, truncated } = await getRangePatch(this.git, repoPath, mb, headSha, MAX_DIFF_BYTES);
      const changedPaths = (await this.git.stdout(repoPath, ['diff', '--name-only', '-M', `${mb}...${headSha}`], { readOnly: true, okExitCodes: [1], signal })).split('\n').filter(Boolean);

      const rawTemplate = await findPullRequestTemplate(repoPath);
      const templateHeadings = rawTemplate ? extractTemplateHeadings(rawTemplate) : [];
      const templateChecklistLabels = rawTemplate ? templateCheckboxLabels(rawTemplate) : new Set<string>();
      const normalizedTemplate = rawTemplate ? rawTemplate.replace(/\r\n/g, '\n') : null;
      const templateTruncated = !!normalizedTemplate && normalizedTemplate.length > MAX_TEMPLATE_CHARS;
      const templateForPrompt = normalizedTemplate ? normalizedTemplate.slice(0, MAX_TEMPLATE_CHARS) : null;

      const validIssues = collectIssueReferences(
        capped.map((c) => `${c.summary}\n${c.body}`),
        input.existingBody,
      );
      const issueDetails = new Map<number, { title: string; state: string }>();
      if (validIssues.length && this.tools.current().ghAccount) {
        const ref = await this.repos.detectGitHub(repoPath);
        if (ref) {
          const toFetch = validIssues.slice(0, MAX_ISSUES_FETCHED);
          const fetched = await Promise.all(toFetch.map((r) => this.gh.issueView(ref, r.number)));
          for (const issue of fetched) if (issue) issueDetails.set(issue.number, { title: issue.title, state: issue.state });
        }
      }
      const promptIssues: PrDraftPromptIssue[] = validIssues.map((r) => ({ number: r.number, closing: r.closing, title: issueDetails.get(r.number)?.title ?? '', state: issueDetails.get(r.number)?.state ?? '' }));

      report('thinking', `Drafting with ${settings.model}…`);
      const response = await backend.complete({
        system: PR_DRAFT_SYSTEM_PROMPT,
        prompt: buildPrDraftPrompt({
          branch: input.head,
          base: input.base,
          commits,
          totalCommits: totalAhead,
          subjectsOnly,
          stat,
          diff: patch,
          diffTruncated: truncated,
          template: templateForPrompt,
          templateTruncated,
          issues: promptIssues,
          existingTitle: input.existingTitle,
          existingBody: input.existingBody,
        }),
        schema: PR_DRAFT_SCHEMA as unknown as Record<string, unknown>,
        model: settings.model,
        effort: settings.effort === 'max' ? 'high' : settings.effort,
        signal,
        onProgress: (m) => report('writing', m),
      });

      const json = response.json as { title?: unknown; body?: unknown; linkedIssues?: unknown; templateSectionsFilled?: unknown };
      const title = normalizePrTitle(typeof json.title === 'string' ? stripFences(json.title) : '');
      if (!title) throw new AiError('The model returned an empty title.', 'invalid-output');

      let body = typeof json.body === 'string' ? stripFences(json.body).trim() : '';
      let restored = false;
      if (rawTemplate && templateHeadings.length) {
        if (!headingsPresentInOrder(body, templateHeadings)) {
          body = restoreTemplateStructure(body, rawTemplate);
          restored = true;
        } else if (detectLineEnding(rawTemplate) === '\r\n') {
          body = body.replace(/\r\n|\r|\n/g, '\r\n');
        }
        body = restoreCheckboxes(body, templateChecklistLabels, changedPaths);
      }
      body = capBody(downgradeUnallowedClosings(body.trim(), validIssues));

      const linkedIssues = reconcileLinkedIssues(json.linkedIssues, validIssues);
      const templateSectionsFilled = Array.isArray(json.templateSectionsFilled) ? json.templateSectionsFilled.filter((s): s is string => typeof s === 'string') : [];

      report('done', 'Draft ready');
      log.info(`AI PR draft for ${repoPath} (${input.head} -> ${input.base}): ${capped.length}/${totalAhead} commits, ${linkedIssues.length} linked issue(s), via ${backend.name}/${response.model}`);
      return { title, body, linkedIssues, templateSectionsFilled, truncated, restored, model: response.model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!signal.aborted) report('error', message);
      throw err;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
