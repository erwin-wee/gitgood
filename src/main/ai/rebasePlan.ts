/**
 * AI rebase assistant ("Tidy up branch with AI"): proposes an interactive
 * rebase plan (squash fixups, reword uninformative messages, reorder
 * related work, drop empty/revert-pair commits) for the commits ahead of a
 * base branch, validates it against the real range (see
 * ./rebase-plan-core.ts), and applies the user-approved plan by driving the
 * existing squash/reword/reorder/drop operations (see
 * ../git/rebase-apply.ts). Mirrors the split used by review.ts/review-core.ts:
 * orchestration here, pure validation in rebase-plan-core.ts.
 */
import type { OperationOutcome } from '@shared/ipc';
import type { RebaseApplyProgress, RebasePlan, RebasePreflight } from '@shared/types';
import { getCurrentBranchName, getDefaultBranch } from '../git/branches';
import { compareRefs, getCommitFiles, getCommitPatch, isCommitPushed } from '../git/log';
import { EMPTY_TREE_SHA, GitError, type GitClient } from '../git/git';
import { rebaseBaseFor } from '../git/operations';
import { RebaseApplyService, type PendingRebaseApply } from '../git/rebase-apply';
import { getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { budgetCommitPatches, capCommitsForPlanning, REBASE_MAX_PATCH_BYTES_PER_COMMIT, type OriginalCommitInfo, validateRebasePlan } from './rebase-plan-core';
import { buildRebasePlanPrompt, REBASE_PLAN_SCHEMA, REBASE_PLAN_SYSTEM_PROMPT, type RebasePlanPromptCommit } from './prompts';
import { createBackend } from './provider';

function newPlanId(): string {
  return `rebase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RebasePlanService {
  private controller: AbortController | null = null;
  private readonly applier = new RebaseApplyService();

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a plan proposal is in flight; used by the update-install gate alongside the other AI services. */
  isActive(): boolean {
    return this.controller !== null;
  }

  hasPendingApply(repoPath: string): boolean {
    return this.applier.hasPendingApply(repoPath);
  }

  pendingApply(repoPath: string): PendingRebaseApply | null {
    return this.applier.pendingApply(repoPath);
  }

  // ---------------------------------------------------------------------
  // Base resolution
  // ---------------------------------------------------------------------

  private async resolveBaseRef(repoPath: string, base: string): Promise<string | null> {
    if (await this.git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { readOnly: true })) return base;
    if (await this.git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`], { readOnly: true })) return `origin/${base}`;
    return null;
  }

  /** For a History multi-selection: the parent of the chronologically oldest selected commit, so the plan's range still always extends through HEAD (the existing rebase primitives cannot stop short of it). */
  private async resolveBaseForSelection(repoPath: string, shas: string[]): Promise<string | null> {
    return rebaseBaseFor(this.git, repoPath, shas);
  }

  private async resolveEffectiveBase(repoPath: string, base: string, shas: string[] | null): Promise<string | null> {
    if (shas?.length) return this.resolveBaseForSelection(repoPath, shas);
    return this.resolveBaseRef(repoPath, base);
  }

  // ---------------------------------------------------------------------
  // Pre-flight (no AI call)
  // ---------------------------------------------------------------------

  async preflight(repoPath: string, base: string, shas: string[] | null): Promise<RebasePreflight> {
    const resolvedBase = await this.resolveEffectiveBase(repoPath, base, shas);
    if (!resolvedBase) return { base, resolvedBase: null, count: 0, pushedCount: 0, hasMergeCommit: false };
    const { ahead } = await compareRefs(this.git, repoPath, resolvedBase, 'HEAD');
    const hasMergeCommit = ahead.some((c) => c.isMerge);
    let pushedCount = 0;
    for (const c of ahead) if ((await isCommitPushed(this.git, repoPath, c.sha)) === true) pushedCount++;
    return { base, resolvedBase, count: ahead.length, pushedCount, hasMergeCommit };
  }

  // ---------------------------------------------------------------------
  // Planning (one AI call)
  // ---------------------------------------------------------------------

  async plan(repoPath: string, base: string, shas: string[] | null): Promise<RebasePlan> {
    const settings = this.store.getSettings().ai;
    if (settings.provider === 'disabled') throw new AiError('AI features are turned off. Enable them in Options → AI.', 'not-configured');

    const [currentBranch, defaultBranch, status] = await Promise.all([getCurrentBranchName(this.git, repoPath), getDefaultBranch(this.git, repoPath), getStatus(this.git, repoPath)]);
    if (currentBranch && defaultBranch && currentBranch === defaultBranch) {
      throw new AiError(`You're on ${defaultBranch}, the default branch. Switch to a feature branch to tidy it.`, 'other');
    }
    if (status.files.length) throw new AiError('Commit or stash your changes before tidying this branch.', 'other');

    const resolvedBase = await this.resolveEffectiveBase(repoPath, base, shas);
    if (!resolvedBase) throw new GitError({ message: `Base "${base}" was not found locally. Fetch first.`, command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });

    const { ahead } = await compareRefs(this.git, repoPath, resolvedBase, 'HEAD');
    if (!ahead.length) throw new AiError('There are no commits ahead of the base to tidy.', 'other');
    if (ahead.some((c) => c.isMerge)) throw new AiError('This range includes a merge commit; merges cannot be rewritten.', 'other');

    const oldestFirst = [...ahead].reverse();
    const { included, truncated: countTruncated } = capCommitsForPlanning(oldestFirst);
    const includedShas = new Set(included.map((c) => c.sha));

    const [pushedFlags, patchResults] = await Promise.all([
      Promise.all(oldestFirst.map((c) => isCommitPushed(this.git, repoPath, c.sha))),
      Promise.all(included.map((c) => getCommitPatch(this.git, repoPath, c.sha, REBASE_MAX_PATCH_BYTES_PER_COMMIT))),
    ]);

    // Empty-commit and exact-revert-pair detection, restricted to the commits actually offered to
    // the model (only they can be proposed for "drop" — anything beyond the cap always ends up
    // "pick" regardless, via validateRebasePlan's completeness rule).
    const isEmptyBySha = new Map<string, boolean>();
    await Promise.all(
      included.map(async (c) => {
        const files = await getCommitFiles(this.git, repoPath, c.sha, c.parents);
        isEmptyBySha.set(c.sha, files.length === 0);
      }),
    );
    const treeLog = await this.git.stdout(repoPath, ['log', '--format=%H\x1f%T\x1f%P', `${resolvedBase}..HEAD`], { readOnly: true });
    const treeBySha = new Map<string, string>();
    const parentsBySha = new Map<string, string[]>();
    for (const line of treeLog.split('\n')) {
      if (!line.trim()) continue;
      const [sha, tree, parents] = line.split('\x1f');
      treeBySha.set(sha, tree);
      parentsBySha.set(sha, (parents ?? '').trim().split(' ').filter(Boolean));
    }
    const baseTree = (await this.git.stdout(repoPath, ['rev-parse', `${resolvedBase}^{tree}`], { readOnly: true })).trim();
    const parentTreeOf = (sha: string): string => {
      const parents = parentsBySha.get(sha) ?? [];
      if (!parents.length) return EMPTY_TREE_SHA;
      return treeBySha.get(parents[0]) ?? baseTree;
    };
    const revertPairSha = new Map<string, string>();
    for (let i = 0; i < included.length; i++) {
      for (let j = i + 1; j < included.length; j++) {
        const a = included[i].sha;
        const b = included[j].sha;
        if (treeBySha.get(a) === parentTreeOf(b) && parentTreeOf(a) === treeBySha.get(b)) {
          revertPairSha.set(a, b);
          revertPairSha.set(b, a);
        }
      }
    }

    const budgetInput = included.map((c, i) => ({ sha: c.sha, patchBytes: Buffer.byteLength(patchResults[i].patch, 'utf8') }));
    const { includePatch, truncated: budgetTruncated } = budgetCommitPatches(budgetInput);
    const truncated = countTruncated || budgetTruncated;

    const originalCommits: OriginalCommitInfo[] = oldestFirst.map((c, i) => ({
      sha: c.sha,
      authorDate: c.author.date,
      message: c.body ? `${c.summary}\n\n${c.body}` : c.summary,
      pushed: pushedFlags[i] === true,
      isEmpty: isEmptyBySha.get(c.sha) ?? false,
      revertPairSha: revertPairSha.get(c.sha) ?? null,
    }));

    const promptCommits: RebasePlanPromptCommit[] = included.map((c, i) => ({
      sha: c.sha,
      author: c.author.name,
      date: c.author.date,
      message: c.body ? `${c.summary}\n\n${c.body}` : c.summary,
      pushed: pushedFlags[i] === true,
      stat: patchResults[i].stat ?? null,
      patch: includePatch.has(c.sha) ? patchResults[i].patch : null,
    }));

    const { backend, settings: aiSettings } = await createBackend(this.store, this.tools);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const currentBranchLabel = currentBranch ?? 'HEAD';
      const response = await backend.complete({
        system: REBASE_PLAN_SYSTEM_PROMPT,
        prompt: buildRebasePlanPrompt({ base: resolvedBase, branch: currentBranchLabel, commits: promptCommits, truncated }),
        schema: REBASE_PLAN_SCHEMA as unknown as Record<string, unknown>,
        model: aiSettings.model,
        effort: aiSettings.effort,
        signal: controller.signal,
      });
      const validated = validateRebasePlan(response.json, originalCommits);
      const startSha = (await this.git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
      const plan: RebasePlan = { id: newPlanId(), base: resolvedBase, startSha, rows: validated.rows, warnings: validated.warnings, alreadyTidy: validated.alreadyTidy, truncated, model: response.model };
      log.info(`AI rebase plan ${plan.id} for ${repoPath}: ${plan.rows.length} row(s), ${plan.warnings.length} warning(s), via ${backend.name}/${response.model}${includedShas.size < oldestFirst.length ? ` (${includedShas.size}/${oldestFirst.length} commits sent)` : ''}`);
      return plan;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  // ---------------------------------------------------------------------
  // Apply / continue / abort / undo
  // ---------------------------------------------------------------------

  async apply(repoPath: string, plan: RebasePlan, onProgress: (e: RebaseApplyProgress) => void): Promise<OperationOutcome> {
    return this.applier.apply(this.git, repoPath, plan, onProgress);
  }

  async continueApply(repoPath: string, unsigned: boolean): Promise<OperationOutcome> {
    return this.applier.continueApply(this.git, repoPath, unsigned);
  }

  async abortApply(repoPath: string): Promise<void> {
    return this.applier.abortApply(this.git, repoPath);
  }

  async undo(repoPath: string, startSha: string): Promise<void> {
    return this.applier.undo(this.git, repoPath, startSha);
  }
}
