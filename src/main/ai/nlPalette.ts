/**
 * Orchestration for the AI command palette (add-ai-command-palette): gathers
 * repository context, asks the model for a plan, and runs its response
 * through the pure policy in nlPolicy.ts before anything is shown or run.
 * `run()` re-validates the requested steps against a freshly gathered
 * repository context before executing anything — a plan is a proposal, not a
 * credential, so a stale or tampered plan object can never widen what runs.
 */
import type { ApiMethods } from '@shared/ipc';
import type { GitErrorInfo, NlPlan, NlProgressEvent, NlRisk, NlRunResult, NlStep, OperationKind } from '@shared/types';
import { getBranches } from '../git/branches';
import { GitError, toGitErrorInfo, type GitClient } from '../git/git';
import { getRemotes, getStashes, getTags } from '../git/operations';
import { getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { evaluatePlan, type NlPolicyContext, type RawNlPlan, type RawNlStep } from './nlPolicy';
import { buildNlPalettePrompt, NL_PALETTE_SCHEMA, NL_PALETTE_SYSTEM_PROMPT, type NlPalettePromptContext } from './prompts';
import { createBackend } from './provider';

const RISKS: NlRisk[] = ['safe', 'changes-history', 'discards-work', 'touches-remote'];
const MAX_ARGV_LENGTH = 20;
const HISTORY_COMMIT_COUNT = 30;
const MAX_BRANCHES_SENT = 100;
const MAX_TAGS_SENT = 50;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Defensively parses the model's raw JSON into a RawNlPlan; malformed steps are dropped rather than trusted (the JSON schema already constrains this for the Anthropic backend, but the Claude Code CLI backend's enforcement is weaker). */
export function parseModelOutput(json: unknown): RawNlPlan {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const clarifyingQuestion = typeof obj.clarifyingQuestion === 'string' && obj.clarifyingQuestion.trim() ? obj.clarifyingQuestion.trim().slice(0, 500) : null;
  if (clarifyingQuestion) return { clarifyingQuestion, steps: [] };
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  const steps: RawNlStep[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Record<string, unknown>;
    const argv = rec.argv;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) continue;
    const explanation = typeof rec.explanation === 'string' ? rec.explanation.trim().slice(0, 300) : '';
    const risk = RISKS.includes(rec.risk as NlRisk) ? (rec.risk as NlRisk) : 'changes-history';
    steps.push({ argv: (argv as string[]).slice(0, MAX_ARGV_LENGTH), explanation, risk });
  }
  // Intentionally not capped to MAX_STEPS here: evaluatePlan rejects the whole plan when it is over
  // the limit (spec's "Too many steps" scenario), which requires seeing the true count.
  return { clarifyingQuestion: null, steps };
}

async function gatherContext(git: GitClient, repoPath: string): Promise<{ policy: NlPolicyContext; prompt: Omit<NlPalettePromptContext, 'request' | 'priorQuestion' | 'answer'> }> {
  const [status, branches, tags, stashes, remotes] = await Promise.all([getStatus(git, repoPath), getBranches(git, repoPath), getTags(git, repoPath), getStashes(git, repoPath), getRemotes(git, repoPath)]);
  const commitsOut = await git.tryRun(repoPath, ['log', `--max-count=${HISTORY_COMMIT_COUNT}`, '--format=%h %s'], { readOnly: true });
  const commits = commitsOut ? commitsOut.stdout.split('\n').filter(Boolean) : [];
  const policy: NlPolicyContext = {
    branches: branches.map((b) => b.name),
    tags: tags.map((t) => t.name),
    statusPaths: status.files.map((f) => f.path),
    stashes: stashes.map((s) => ({ index: s.index, sha: s.sha })),
    currentBranch: status.branch.name,
    detached: status.branch.detached,
    operation: status.operation.kind,
  };
  const prompt: Omit<NlPalettePromptContext, 'request' | 'priorQuestion' | 'answer'> = {
    branch: status.branch.name,
    detached: status.branch.detached,
    operation: status.operation.kind,
    aheadBehind: status.branch.upstream ? { ahead: status.branch.ahead, behind: status.branch.behind, upstream: status.branch.upstream } : null,
    branches: branches.slice(0, MAX_BRANCHES_SENT).map((b) => ({ name: b.name, kind: b.kind, isCurrent: b.isCurrent })),
    commits,
    stashes: stashes.map((s) => ({ index: s.index, message: s.message })),
    remotes: remotes.map((r) => r.name),
    tags: tags.slice(0, MAX_TAGS_SENT).map((t) => t.name),
    platform: process.platform,
  };
  return { policy, prompt };
}

/** Fixed preview table (design.md): a read-only command per mapped action, run only after its refs are re-verified to exist. */
async function computePreview(git: GitClient, repoPath: string, step: NlStep): Promise<NlStep> {
  if (!step.executable || !step.mappedAction) return step;
  const verifyRef = async (ref: string): Promise<boolean> => (await git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { readOnly: true })) !== null;
  const fail = (ref: string): NlStep => ({ ...step, executable: false, refusalReason: `"${ref}" no longer resolves to a commit.`, mappedAction: null, mappedArgs: [], preview: null });
  const capped = (lines: string[], max = 20): string[] => (lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines);

  try {
    switch (step.mappedAction) {
      case 'git.undoCommit': {
        const target = 'HEAD~1';
        if (!(await verifyRef(target))) return fail(target);
        const out = await git.tryRun(repoPath, ['log', '--oneline', `${target}..HEAD`], { readOnly: true });
        return { ...step, preview: { title: 'Commits that would be uncommitted (kept as changes)', lines: capped((out?.stdout ?? '').split('\n').filter(Boolean)) } };
      }
      case 'git.discard': {
        const paths = (step.mappedArgs[0] as string[]) ?? [];
        const out = await git.tryRun(repoPath, ['status', '--porcelain', '--', ...paths], { readOnly: true });
        return { ...step, preview: { title: 'Changed files that would be discarded', lines: capped((out?.stdout ?? '').split('\n').filter(Boolean)) } };
      }
      case 'git.discardAll': {
        const out = await git.tryRun(repoPath, ['status', '--porcelain'], { readOnly: true });
        return { ...step, preview: { title: 'All changes that would be discarded', lines: capped((out?.stdout ?? '').split('\n').filter(Boolean)) } };
      }
      case 'git.branch.delete': {
        const name = step.mappedArgs[0] as string;
        if (!(await verifyRef(name))) return fail(name);
        const [last, merged] = await Promise.all([git.tryRun(repoPath, ['log', '-1', '--oneline', name], { readOnly: true }), git.tryRun(repoPath, ['branch', '--merged'], { readOnly: true })]);
        const isMerged = (merged?.stdout ?? '').split('\n').some((l) => l.replace(/^\*?\s*/, '').trim() === name);
        return { ...step, preview: { title: isMerged ? 'This branch is merged' : 'This branch is NOT merged', lines: capped((last?.stdout ?? '').split('\n').filter(Boolean)) } };
      }
      case 'git.rebase': {
        const onto = step.mappedArgs[0] as string;
        if (!(await verifyRef(onto))) return fail(onto);
        const out = await git.tryRun(repoPath, ['log', '--oneline', `${onto}..HEAD`], { readOnly: true });
        return { ...step, preview: { title: 'Commits that would be replayed onto the new base', lines: capped((out?.stdout ?? '').split('\n').filter(Boolean)) } };
      }
      case 'git.push': {
        const opts = step.mappedArgs[0] as { force: boolean } | undefined;
        if (!opts?.force) return step;
        const out = await git.tryRun(repoPath, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], { readOnly: true });
        return { ...step, preview: { title: 'Ahead/behind the upstream branch (behind ahead)', lines: capped((out?.stdout ?? '').split('\n').filter(Boolean)) } };
      }
      default:
        return step;
    }
  } catch {
    return step;
  }
}

/** ApiMethods keys allowed as an NlStep.mappedAction; the sentinel 'git.tryRun' is handled separately (read-only, via GitClient directly). Anything else is refused even if a tampered plan object names it. */
const EXECUTABLE_ACTIONS = new Set<keyof ApiMethods>([
  'git.checkout',
  'git.branch.create',
  'git.branch.rename',
  'git.branch.delete',
  'git.undoCommit',
  'git.revert',
  'git.revert.continue',
  'git.revert.abort',
  'git.cherryPick',
  'git.cherryPick.continue',
  'git.cherryPick.abort',
  'git.stash.push',
  'git.stash.pop',
  'git.stash.apply',
  'git.stash.drop',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.merge',
  'git.merge.abort',
  'git.merge.continue',
  'git.rebase',
  'git.rebase.abort',
  'git.rebase.continue',
  'git.discard',
  'git.discardAll',
  'git.tag.create',
  'git.tag.delete',
  'git.tag.push',
]);

export class NlPaletteService {
  private controller: AbortController | null = null;
  /** One request (plan or run) at a time per repository, per spec.md/design.md. */
  private busy = new Set<string>();

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  isActive(): boolean {
    return this.controller !== null || this.busy.size > 0;
  }

  private async withBusy<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(repoPath)) throw new AiError('Another command palette request is already running for this repository.', 'other');
    this.busy.add(repoPath);
    try {
      return await fn();
    } finally {
      this.busy.delete(repoPath);
    }
  }

  async plan(repoPath: string, request: string, priorQuestion: string | null, answer: string | null): Promise<NlPlan> {
    return this.withBusy(repoPath, async () => {
      const { backend, settings } = await createBackend(this.store, this.tools);
      const controller = new AbortController();
      this.controller = controller;
      try {
        const { policy, prompt } = await gatherContext(this.git, repoPath);
        const response = await backend.complete({
          system: NL_PALETTE_SYSTEM_PROMPT,
          prompt: buildNlPalettePrompt({ ...prompt, request, priorQuestion, answer }),
          schema: NL_PALETTE_SCHEMA as unknown as Record<string, unknown>,
          model: settings.model,
          effort: settings.effort,
          signal: controller.signal,
        });
        const raw = parseModelOutput(response.json);
        const evaluated = evaluatePlan(raw, policy);
        const clarifyingQuestion = evaluated.tooManySteps ? 'That request needs more than 8 steps; try splitting it into smaller requests.' : evaluated.clarifyingQuestion;
        return { id: newId(), request, steps: evaluated.steps, clarifyingQuestion, model: response.model };
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    });
  }

  async preview(repoPath: string, step: NlStep): Promise<NlStep> {
    return computePreview(this.git, repoPath, step);
  }

  async run(repoPath: string, plan: NlPlan, confirmedStepIds: string[], report: (e: Omit<NlProgressEvent, 'repoPath'>) => void): Promise<NlRunResult> {
    return this.withBusy(repoPath, async () => {
      // Re-validate every step against a freshly gathered repository context: a plan is a proposal
      // carried over IPC, never a credential, so nothing about it is trusted at execution time beyond
      // its original argv/explanation/risk (the model's raw proposal) — mappedAction/mappedArgs here
      // are recomputed by the same pure policy that built the plan, not read back from `plan.steps`.
      const { policy } = await gatherContext(this.git, repoPath);
      const revalidated = evaluatePlan({ clarifyingQuestion: null, steps: plan.steps.map((s) => ({ argv: s.argv, explanation: s.explanation, risk: s.risk })) }, policy);
      const wanted = new Set(confirmedStepIds);
      const isRunnable = (s: NlStep): boolean => s.executable && !!s.mappedAction && (s.mappedAction === 'git.tryRun' || EXECUTABLE_ACTIONS.has(s.mappedAction as keyof ApiMethods));
      const completed: string[] = [];
      let failedStep: string | null = null;
      let error: GitErrorInfo | null = null;
      let stoppedAt = -1;

      for (let i = 0; i < revalidated.steps.length; i++) {
        const step = revalidated.steps[i];
        if (!wanted.has(step.id)) continue;
        if (!isRunnable(step)) {
          failedStep = step.id;
          error = { message: step.refusalReason ?? 'This step is not executable.', command: step.display, exitCode: null, stderr: '', stdout: '', code: 'unknown' };
          log.warn(`ai.nl.run refused step ${step.id} ("${step.display}"): ${error.message}`);
          stoppedAt = i;
          break;
        }
        report({ planId: plan.id, stepId: step.id, phase: 'running' });
        try {
          let exitCode: number | null = 0;
          if (step.mappedAction === 'git.tryRun') {
            const argv = step.mappedArgs[0] as string[];
            const res = await this.git.tryRun(repoPath, argv, { readOnly: true });
            exitCode = res ? 0 : 1;
          } else {
            await this.dispatch(step.mappedAction as string, repoPath, step.mappedArgs);
          }
          log.info(`ai.nl.run executed "git ${step.display}" (exit ${exitCode})`);
          completed.push(step.id);
          report({ planId: plan.id, stepId: step.id, phase: 'done' });
        } catch (err) {
          const info = toGitErrorInfo(err);
          log.info(`ai.nl.run executed "git ${step.display}" (exit ${info.exitCode ?? 'n/a'}): ${info.message.split('\n')[0]}`);
          failedStep = step.id;
          error = info;
          report({ planId: plan.id, stepId: step.id, phase: 'error' });
          stoppedAt = i;
          break;
        }
      }

      if (!failedStep) {
        stoppedAt = revalidated.steps.length - 1;
        for (let i = 0; i < revalidated.steps.length; i++) if (wanted.has(revalidated.steps[i].id)) stoppedAt = Math.max(stoppedAt, i);
        const next = revalidated.steps.slice(stoppedAt + 1).find((s) => !wanted.has(s.id));
        if (next && next.executable && next.risk !== 'safe') report({ planId: plan.id, stepId: next.id, phase: 'awaiting-confirmation' });
      }

      return { planId: plan.id, completed, failedStep, error };
    });
  }

  /** Calls the real handler for an already-registered ApiMethods key, exactly as the renderer's manual actions do (same wrappers, same withBusy/progress/dialog-adjacent behaviour where applicable). Wired from ipc.ts via setDispatcher so this module never has to import the whole handlers table itself. */
  private dispatchFn: ((action: keyof ApiMethods, repoPath: string, args: unknown[]) => Promise<unknown>) | null = null;

  setDispatcher(fn: (action: keyof ApiMethods, repoPath: string, args: unknown[]) => Promise<unknown>): void {
    this.dispatchFn = fn;
  }

  private async dispatch(action: string, repoPath: string, args: unknown[]): Promise<unknown> {
    if (!this.dispatchFn) throw new GitError({ message: 'The command palette is not fully wired up.', command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
    return this.dispatchFn(action as keyof ApiMethods, repoPath, args);
  }
}

export { EXECUTABLE_ACTIONS };
export type { OperationKind };
