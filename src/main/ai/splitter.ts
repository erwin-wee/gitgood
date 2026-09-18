import type { CommitOptions, DiffHunk, SplitApplyProgress, SplitHunk, SplitPlan, SplitPreflight, WorkingFile } from '@shared/types';
import { buildStagePatch, selectHunks } from '@shared/diff/patch';
import { languageFromPath } from '@shared/util';
import { createCommit, isUnborn, unstageAll } from '../git/commit';
import { getWorkingDiff } from '../git/diff';
import type { GitClient } from '../git/git';
import { getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { createBackend } from './provider';
import { buildSplitPrompt, SPLIT_SCHEMA, SPLIT_SYSTEM_PROMPT, type SplitPromptHunkInput } from './prompts';
import { annotateHunks } from './review-core';
import { classifySplitFile, computeHunkId, SPLIT_DELETED_HASH, SPLIT_PROMPT_BUDGET_BYTES, staleSplitPaths, validateSplitResponse, wholeFileReason } from './splitter-core';

function newPlanId(): string {
  return `split-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ClassifiedIncluded {
  hunks: SplitHunk[];
  /** Per-path working-diff hunks, for files classified as splittable ('hunks' mode). */
  hunksByFile: Map<string, DiffHunk[]>;
  wholeFileOnly: { path: string; reason: string }[];
  excluded: { path: string; reason: string }[];
  byPath: Map<string, WorkingFile>;
}

/**
 * AI commit splitting: proposes grouping the pending working-tree hunks and
 * whole-file changes into an ordered set of commits, then applies the
 * user-edited plan through the exact same partial-patch path a manual
 * partial commit uses (see src/main/git/commit.ts's createCommit). Nothing
 * is staged or committed until `apply` runs; `plan` only reads diffs and
 * calls the model.
 */
export class SplitterService {
  private controller: AbortController | null = null;

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a plan proposal is in flight; used by the update-install gate. */
  isActive(): boolean {
    return this.controller !== null;
  }

  private async fileHash(repoPath: string, path: string): Promise<string> {
    const res = await this.git.tryRun(repoPath, ['hash-object', '--', path], { readOnly: true });
    return res ? res.stdout.trim() : SPLIT_DELETED_HASH;
  }

  /**
   * Classifies every included path into splittable hunks, whole-file-only
   * changes, or excluded (conflicted) — the shared groundwork for both the
   * fast pre-flight and the AI-calling plan.
   */
  private async classifyIncluded(repoPath: string, files: string[]): Promise<ClassifiedIncluded> {
    const status = await getStatus(this.git, repoPath);
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    const hunks: SplitHunk[] = [];
    const hunksByFile = new Map<string, DiffHunk[]>();
    const wholeFileOnly: { path: string; reason: string }[] = [];
    const excluded: { path: string; reason: string }[] = [];

    for (const path of files) {
      const file = byPath.get(path);
      if (!file) continue;
      let fileHunks: DiffHunk[] = [];
      let unsplittableReason: string | null = null;
      if (!file.conflict) {
        const diff = await getWorkingDiff(this.git, repoPath, file, { hideWhitespace: false });
        if (diff.kind === 'text') fileHunks = diff.hunks;
        else unsplittableReason = diff.kind === 'binary' ? 'binary file' : diff.kind === 'image' ? 'image file' : diff.kind === 'submodule' ? 'submodule' : diff.kind === 'lfs' ? 'Git LFS pointer' : 'no splittable text changes';
      }
      const mode = classifySplitFile(file, fileHunks.length > 0);
      if (mode === 'hunks') {
        hunksByFile.set(path, fileHunks);
        fileHunks.forEach((hunk, hunkIndex) => {
          hunks.push({
            id: computeHunkId(path, hunk),
            path,
            hunkIndex,
            header: hunk.header,
            additions: hunk.lines.filter((l) => l.type === 'add').length,
            deletions: hunk.lines.filter((l) => l.type === 'delete').length,
          });
        });
      } else if (mode === 'whole') {
        wholeFileOnly.push({ path, reason: wholeFileReason(file) });
      } else {
        excluded.push({ path, reason: file.conflict ? 'conflicted' : (unsplittableReason ?? 'no splittable text changes') });
      }
    }
    return { hunks, hunksByFile, wholeFileOnly, excluded, byPath };
  }

  /** Fast, non-AI summary shown before the model is ever called. */
  async preflight(repoPath: string, files: string[]): Promise<SplitPreflight> {
    const { hunks, hunksByFile, wholeFileOnly, excluded } = await this.classifyIncluded(repoPath, files);
    let estimatedBytes = 0;
    for (const fileHunks of hunksByFile.values()) estimatedBytes += annotateHunks(fileHunks).length;
    return {
      fileCount: hunksByFile.size + wholeFileOnly.length,
      hunkCount: hunks.length,
      wholeFileOnly,
      excluded,
      estimatedBytes,
      oversized: estimatedBytes > SPLIT_PROMPT_BUDGET_BYTES,
    };
  }

  /** Calls the model to group the included changes into an ordered set of commits; stages or commits nothing. `fileOnly` forces headers/stats only regardless of size (the pre-flight's explicit choice); it is forced automatically above the byte budget either way. */
  async plan(repoPath: string, files: string[], fileOnly = false): Promise<SplitPlan> {
    const settings = this.store.getSettings().ai;
    if (settings.provider === 'disabled') throw new AiError('AI features are turned off. Enable them in Options → AI.', 'not-configured');
    const status = await getStatus(this.git, repoPath);
    if (status.operation.kind === 'merge' || status.operation.kind === 'cherry-pick' || status.operation.kind === 'revert') {
      throw new AiError('Finish the current merge before splitting changes into commits.', 'other');
    }
    if (await isUnborn(this.git, repoPath)) throw new AiError('Make an initial commit before splitting changes into commits.', 'other');

    const { hunks, hunksByFile, wholeFileOnly } = await this.classifyIncluded(repoPath, files);
    const wholeFileOnlyPaths = wholeFileOnly.map((f) => f.path);
    if (hunks.length + wholeFileOnlyPaths.length < 2) throw new AiError('At least two hunks or whole files are needed to split into commits.', 'other');

    const { backend, settings: aiSettings } = await createBackend(this.store, this.tools);
    const controller = new AbortController();
    this.controller = controller;
    try {
      let bytes = 0;
      for (const fileHunks of hunksByFile.values()) bytes += annotateHunks(fileHunks).length;
      const bodiesIncluded = !fileOnly && bytes <= SPLIT_PROMPT_BUDGET_BYTES;
      const promptHunks: SplitPromptHunkInput[] = hunks.map((h) => {
        const dh = hunksByFile.get(h.path)![h.hunkIndex];
        return { id: h.id, path: h.path, header: h.header, language: languageFromPath(h.path), additions: h.additions, deletions: h.deletions, body: bodiesIncluded ? annotateHunks([dh]) : null };
      });
      const prompt = buildSplitPrompt({ branch: status.branch.name, hunks: promptHunks, wholeFileOnly: wholeFileOnly.map((f) => ({ path: f.path, status: f.reason })), bodiesIncluded });
      const response = await backend.complete({ system: SPLIT_SYSTEM_PROMPT, prompt, schema: SPLIT_SCHEMA as unknown as Record<string, unknown>, model: aiSettings.model, effort: aiSettings.effort, signal: controller.signal });
      const { commits, unassigned, warnings } = validateSplitResponse(response.json, hunks, wholeFileOnlyPaths);

      const startSha = (await this.git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
      const fileHashes: Record<string, string> = {};
      for (const path of new Set([...hunksByFile.keys(), ...wholeFileOnlyPaths])) fileHashes[path] = await this.fileHash(repoPath, path);

      const plan: SplitPlan = { id: newPlanId(), startSha, fileHashes, hunks, commits, unassigned, warnings, model: response.model };
      log.info(`AI split plan ${plan.id}: ${commits.length} commit(s) from ${hunks.length} hunk(s)/${wholeFileOnlyPaths.length} whole file(s) via ${backend.name}/${response.model}`);
      return plan;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /**
   * Creates the plan's commits in order using `createCommit` (the same
   * partial-patch path a manual partial commit uses). Each commit's patch
   * is rebuilt from a fresh working diff (never the plan-time index),
   * matched by content-derived hunk id, so a commit that lands earlier in
   * the sequence and shifts a sibling hunk's line numbers never breaks a
   * later commit touching the same file. Stops on the first failure,
   * leaving already-created commits intact and nothing staged for the one
   * that failed (createCommit rebuilds the index from scratch every time).
   */
  async apply(repoPath: string, plan: SplitPlan, report: (e: SplitApplyProgress) => void): Promise<{ shas: string[] }> {
    const status = await getStatus(this.git, repoPath);
    if (status.operation.kind === 'merge' || status.operation.kind === 'cherry-pick' || status.operation.kind === 'revert') {
      throw new AiError('Finish the current merge before applying a split.', 'other');
    }
    const byPath = new Map(status.files.map((f) => [f.path, f]));

    const current: Record<string, string> = {};
    for (const path of Object.keys(plan.fileHashes)) current[path] = await this.fileHash(repoPath, path);
    const stale = staleSplitPaths(plan.fileHashes, current);
    if (stale.length) {
      throw new AiError(`The working tree changed since this plan was made (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''}). Re-propose the split.`, 'stale');
    }

    const hunkById = new Map(plan.hunks.map((h) => [h.id, h]));
    const shas: string[] = [];
    const total = plan.commits.length;
    for (let i = 0; i < plan.commits.length; i++) {
      const commit = plan.commits[i];
      report({ planId: plan.id, index: i, total, sha: null, phase: 'staging', message: `Staging commit ${i + 1} of ${total}: ${commit.summary}` });

      try {
        const hunkIdsByPath = new Map<string, string[]>();
        for (const id of commit.hunkIds) {
          const h = hunkById.get(id);
          if (!h) throw new AiError(`Hunk ${id} is not part of this plan.`, 'other');
          hunkIdsByPath.set(h.path, [...(hunkIdsByPath.get(h.path) ?? []), id]);
        }

        const partialPatches: Record<string, string> = {};
        for (const [path, ids] of hunkIdsByPath) {
          const file = byPath.get(path);
          if (!file) throw new AiError(`"${path}" is no longer part of the working tree. Re-propose the split.`, 'stale');
          const diff = await getWorkingDiff(this.git, repoPath, file, { hideWhitespace: false });
          if (diff.kind !== 'text') throw new AiError(`Could not re-read the diff for "${path}". Re-propose the split.`, 'stale');
          const idToIndex = new Map(diff.hunks.map((hh, idx) => [computeHunkId(path, hh), idx] as const));
          const indices: number[] = [];
          for (const id of ids) {
            const idx = idToIndex.get(id);
            if (idx === undefined) throw new AiError(`A hunk in "${path}" could not be found. Re-propose the split.`, 'stale');
            indices.push(idx);
          }
          const patch = buildStagePatch({ oldPath: diff.oldPath, newPath: diff.newPath, hunks: diff.hunks }, selectHunks(indices));
          if (patch) partialPatches[path] = patch;
        }

        const wholeFilePaths = commit.wholeFiles.flatMap((path) => {
          const file = byPath.get(path);
          return file?.oldPath ? [path, file.oldPath] : [path];
        });
        const filesForCommit = [...new Set([...Object.keys(partialPatches), ...wholeFilePaths])];
        const opts: CommitOptions = { summary: commit.summary, description: commit.description, coAuthors: [], amend: false, files: filesForCommit, partialPatches, signOverride: 'default' };

        report({ planId: plan.id, index: i, total, sha: null, phase: 'committing', message: `Committing ${i + 1} of ${total}: ${commit.summary}` });
        const sha = await createCommit(this.git, repoPath, opts, false);
        shas.push(sha);
        report({ planId: plan.id, index: i, total, sha, phase: 'done', message: `Committed ${sha.slice(0, 7)}: ${commit.summary}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report({ planId: plan.id, index: i, total, sha: null, phase: 'error', message: `Commit ${i + 1} of ${total} ("${commit.summary}") failed: ${message}` });
        throw err;
      }
    }
    return { shas };
  }

  /** Restores the pre-split HEAD, keeping every change unstaged in the working tree; refuses when `startSha` is no longer an ancestor of HEAD. */
  async undo(repoPath: string, startSha: string): Promise<void> {
    const head = (await this.git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
    if (head === startSha) return;
    const isAncestor = (await this.git.tryRun(repoPath, ['merge-base', '--is-ancestor', startSha, head], { readOnly: true })) !== null;
    if (!isAncestor) throw new AiError('The repository has changed since this split; undo is no longer available.', 'other');
    // Refuse when any of the split's own commits (HEAD down to, but not including, startSha) already reached the upstream: soft-resetting past a pushed commit would silently rewrite published history.
    const upstream = (await this.git.tryRun(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { readOnly: true }))?.stdout.trim();
    if (upstream) {
      // If any split commit reached the upstream, the oldest one did (it is an ancestor of the others), so testing it covers a partial push too.
      const oldest = (await this.git.tryRun(repoPath, ['rev-list', '--reverse', `${startSha}..${head}`], { readOnly: true }))?.stdout.trim().split('\n')[0] ?? head;
      const pushed = (await this.git.tryRun(repoPath, ['merge-base', '--is-ancestor', oldest, upstream], { readOnly: true })) !== null;
      if (pushed) throw new AiError('These commits have already been pushed; undoing now would rewrite published history. Revert them instead.', 'other');
    }
    await this.git.run(repoPath, ['reset', '--soft', startSha]);
    await unstageAll(this.git, repoPath);
  }
}
