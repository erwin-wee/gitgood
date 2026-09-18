/**
 * AI diff explanation: builds a plain-language explanation of a commit, a
 * file's diff or a selected range of lines, plus up to five follow-up
 * questions about the same target. Read-only: never writes to the
 * repository or GitHub. Mirrors the split used by review.ts/review-core.ts
 * (orchestration here, pure validation in explain-core.ts).
 */
import type { DiffOptions } from '@shared/ipc';
import type { CommitFile, ExplainFollowUp, ExplainSource, ExplainTarget, Explanation, WorkingFile } from '@shared/types';
import { EXPLAIN_FOLLOWUP_LIMIT } from '@shared/types';
import { parseUnifiedDiff } from '@shared/diff/parse';
import { getCommitFileDiff, getStashFileDiff, getWorkingDiff } from '../git/diff';
import type { GitClient } from '../git/git';
import { getCommit, getCommitFiles, getCommitPatch, getRecentFileHistory } from '../git/log';
import { getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { createBackend } from './provider';
import { buildExplainFollowUpPrompt, buildExplainPrompt, EXPLAIN_FOLLOWUP_SCHEMA, EXPLAIN_FOLLOWUP_SYSTEM_PROMPT, EXPLAIN_SCHEMA, EXPLAIN_SYSTEM_PROMPT, type ExplainFilePromptInput } from './prompts';
import { buildRangeContext, explainCacheKey, indexNewSideLines, isVolatileExplainTarget, markSelectedRange, splitPatchByFile, validateExplanation, validateFollowUpAnswer } from './explain-core';
import { annotateHunks } from './review-core';

const MAX_INPUT_BYTES = 120_000;
const RANGE_CONTEXT_LINES = 40;
/** Last N explanations kept per repository, keyed by target; not persisted across restarts. */
const CACHE_LIMIT = 20;

const NO_DIFF_OPTIONS: DiffOptions = { hideWhitespace: false };

interface CacheEntry {
  explanation: Explanation;
  /** The prompt the explanation was generated from, reused (with appended Q/A pairs) for follow-ups. */
  basePrompt: string;
}

interface PromptResult {
  prompt: string;
  truncated: boolean;
  knownPaths: Map<string, Set<number>>;
}

export class ExplainService {
  private controller: AbortController | null = null;
  private cache = new Map<string, Map<string, CacheEntry>>();

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while an explanation or follow-up is in flight; used by the update install gate alongside the resolver/review services. */
  isActive(): boolean {
    return this.controller !== null;
  }

  private cacheFor(repoPath: string): Map<string, CacheEntry> {
    let m = this.cache.get(repoPath);
    if (!m) {
      m = new Map();
      this.cache.set(repoPath, m);
    }
    return m;
  }

  private remember(repoPath: string, key: string, entry: CacheEntry): void {
    const m = this.cacheFor(repoPath);
    m.delete(key); // re-insert for recency
    m.set(key, entry);
    if (m.size > CACHE_LIMIT) m.delete(m.keys().next().value!);
  }

  async explain(repoPath: string, target: ExplainTarget): Promise<Explanation> {
    const key = explainCacheKey(target);
    const cached = this.cacheFor(repoPath).get(key);
    const volatile = isVolatileExplainTarget(target);
    if (cached && !volatile) return cached.explanation;

    const { backend, settings } = await createBackend(this.store, this.tools);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const built = await this.buildPrompt(repoPath, target);
      // The prompt embeds the file's content, so an unchanged working tree
      // reproduces it exactly; anything else means the file was edited since
      // and the cached explanation no longer describes it.
      if (cached && cached.basePrompt === built.prompt) return cached.explanation;
      const response = await backend.complete({
        system: EXPLAIN_SYSTEM_PROMPT,
        prompt: built.prompt,
        schema: EXPLAIN_SCHEMA as unknown as Record<string, unknown>,
        model: settings.model,
        effort: settings.effort,
        signal: controller.signal,
      });
      const { explanation, droppedReferences } = validateExplanation(response.json, response.model, built.truncated, built.knownPaths);
      if (!explanation) throw new AiError('The model returned an empty explanation. Try again.', 'invalid-output');
      this.remember(repoPath, key, { explanation, basePrompt: built.prompt });
      log.info(`AI explain (${target.kind}) via ${backend.name}/${explanation.model}: ${droppedReferences} reference(s) dropped${built.truncated ? ', input truncated' : ''}`);
      return explanation;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  async followUp(repoPath: string, target: ExplainTarget, history: ExplainFollowUp[], question: string): Promise<string> {
    if (history.length >= EXPLAIN_FOLLOWUP_LIMIT) throw new AiError(`You can ask up to ${EXPLAIN_FOLLOWUP_LIMIT} follow-up questions about the same explanation.`, 'other');
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) throw new AiError('Write a question first.', 'other');

    const key = explainCacheKey(target);
    let entry = this.cacheFor(repoPath).get(key);
    if (!entry) {
      // Regenerates (and re-caches) the base explanation so a follow-up still works after the entry was evicted or the app restarted.
      await this.explain(repoPath, target);
      entry = this.cacheFor(repoPath).get(key);
      if (!entry) throw new AiError('Could not rebuild the original explanation context. Explain the target again.', 'other');
    }

    const { backend, settings } = await createBackend(this.store, this.tools);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await backend.complete({
        system: EXPLAIN_FOLLOWUP_SYSTEM_PROMPT,
        prompt: buildExplainFollowUpPrompt(entry.basePrompt, history, trimmedQuestion),
        schema: EXPLAIN_FOLLOWUP_SCHEMA as unknown as Record<string, unknown>,
        model: settings.model,
        effort: settings.effort === 'max' ? 'high' : settings.effort,
        signal: controller.signal,
      });
      const answer = validateFollowUpAnswer(response.json);
      if (!answer) throw new AiError('The model returned an empty answer.', 'invalid-output');
      return answer;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  // ---------------------------------------------------------------------
  // Prompt building per scope
  // ---------------------------------------------------------------------

  private async buildPrompt(repoPath: string, target: ExplainTarget): Promise<PromptResult> {
    if (target.kind === 'commit') return this.buildCommitPrompt(repoPath, target.sha);
    if (target.kind === 'file') return this.buildFilePrompt(repoPath, target.source, target.path);
    return this.buildRangePrompt(repoPath, target.source, target.path, target.hunkIndex, target.startLine, target.endLine);
  }

  private async buildCommitPrompt(repoPath: string, sha: string): Promise<PromptResult> {
    const commit = await getCommit(this.git, repoPath, sha);
    const files = await getCommitFiles(this.git, repoPath, sha, commit.parents);
    const isMerge = commit.parents.length > 1;
    const isRoot = commit.parents.length === 0;
    const { patch, omitted, truncated } = await getCommitPatch(this.git, repoPath, sha, MAX_INPUT_BYTES);
    const blocks = splitPatchByFile(patch);
    const omittedSet = new Set(omitted);
    const knownPaths = new Map<string, Set<number>>();
    const fileInputs: ExplainFilePromptInput[] = [];
    for (const file of files) {
      const recentHistory = await getRecentFileHistory(this.git, repoPath, sha, file.path);
      if (omittedSet.has(file.path)) {
        knownPaths.set(file.path, new Set());
        fileInputs.push({ path: file.path, oldPath: file.oldPath, status: file.status, annotatedDiff: '(omitted: input size limit reached)', recentHistory });
        continue;
      }
      if (file.binary) {
        knownPaths.set(file.path, new Set());
        fileInputs.push({ path: file.path, oldPath: file.oldPath, status: file.status, annotatedDiff: '(binary file, not shown)', recentHistory });
        continue;
      }
      const text = blocks.get(file.path) ?? '';
      const hunks = parseUnifiedDiff(text).hunks;
      knownPaths.set(file.path, indexNewSideLines(hunks));
      fileInputs.push({ path: file.path, oldPath: file.oldPath, status: file.status, annotatedDiff: hunks.length ? annotateHunks(hunks) : '(no textual changes)', recentHistory });
    }
    const scopeDescription = `Explain commit ${commit.shortSha}${isMerge ? ' (a merge commit, shown against its first parent)' : isRoot ? " (the repository's first commit)" : ''}.`;
    const prompt = buildExplainPrompt({
      scopeDescription,
      isMerge,
      commitMeta: { sha: commit.sha, author: commit.author.name, date: commit.author.date, summary: commit.summary, body: commit.body },
      files: fileInputs,
      truncated,
      omitted,
    });
    return { prompt, truncated, knownPaths };
  }

  private async resolveFileDiff(repoPath: string, source: ExplainSource, path: string) {
    if (source.kind === 'commit') {
      const commit = await getCommit(this.git, repoPath, source.sha);
      const files = await getCommitFiles(this.git, repoPath, source.sha, commit.parents);
      const file: CommitFile = files.find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified', additions: null, deletions: null, binary: false, lfs: false };
      const diff = await getCommitFileDiff(this.git, repoPath, source.sha, commit.parents, file, NO_DIFF_OPTIONS);
      return { diff, label: `commit ${commit.shortSha}` };
    }
    if (source.kind === 'working') {
      const status = await getStatus(this.git, repoPath);
      const file: WorkingFile = status.files.find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified', staged: false, unstaged: true, submodule: false, conflict: null, lfs: false };
      const diff = await getWorkingDiff(this.git, repoPath, file, NO_DIFF_OPTIONS);
      return { diff, label: 'the working tree' };
    }
    const diff = await getStashFileDiff(this.git, repoPath, source.ref, path, NO_DIFF_OPTIONS);
    return { diff, label: `stash ${source.ref.slice(0, 12)}` };
  }

  private async buildFilePrompt(repoPath: string, source: ExplainSource, path: string): Promise<PromptResult> {
    const { diff, label } = await this.resolveFileDiff(repoPath, source, path);
    if (diff.kind !== 'text') throw new AiError('There is nothing to explain in this file (binary, image, submodule or too large).', 'other');
    const hunks = diff.hunks;
    const knownPaths = new Map<string, Set<number>>([[path, indexNewSideLines(hunks)]]);
    const prompt = buildExplainPrompt({
      scopeDescription: `Explain the changes to ${path} in ${label}.`,
      files: [{ path, oldPath: diff.oldPath, status: 'modified', annotatedDiff: annotateHunks(hunks), recentHistory: [] }],
      truncated: false,
      omitted: [],
    });
    return { prompt, truncated: false, knownPaths };
  }

  private async buildRangePrompt(repoPath: string, source: ExplainSource, path: string, hunkIndex: number, startLine: number, endLine: number): Promise<PromptResult> {
    const { diff, label } = await this.resolveFileDiff(repoPath, source, path);
    if (diff.kind !== 'text') throw new AiError('There is nothing to explain in this selection.', 'other');
    const hunk = diff.hunks[hunkIndex];
    if (!hunk) throw new AiError('That selection is no longer part of the diff.', 'other');
    const knownPaths = new Map<string, Set<number>>([[path, indexNewSideLines([hunk])]]);
    const marked = markSelectedRange(annotateHunks([hunk]), startLine, endLine);
    const context = buildRangeContext(diff.newContent, diff.oldContent, hunk, RANGE_CONTEXT_LINES);
    const annotatedDiff = context ? `${marked}\n\nSurrounding context from the file:\n${context}` : marked;
    const prompt = buildExplainPrompt({
      scopeDescription: `Explain lines ${startLine}${endLine !== startLine ? `-${endLine}` : ''} of ${path} in ${label} (marked "<== selected"; the rest of the hunk and surrounding file content are shown for context only).`,
      files: [{ path, oldPath: diff.oldPath, status: 'modified', annotatedDiff, recentHistory: [] }],
      truncated: false,
      omitted: [],
    });
    return { prompt, truncated: false, knownPaths };
  }
}
