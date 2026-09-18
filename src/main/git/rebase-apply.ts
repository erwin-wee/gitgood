/**
 * Applies an AI-proposed rebase plan (see src/main/ai/rebase-plan-core.ts
 * and src/main/ai/rebasePlan.ts) by driving the existing squash/reword/
 * reorder/drop primitives in operations.ts, one atomic step at a time, in
 * the computed order (drops, rewords, reorders, squashes). Each existing
 * primitive rewrites every commit sha from its own minimal base onward, so
 * the sha every step needs to target is re-resolved from a fresh `git log`
 * before that step runs (see remapShas in rebase-plan-core.ts).
 *
 * Conflicts are handled like any other in-progress rebase: the step's
 * OperationOutcome comes back 'conflicts' and the caller shows the existing
 * conflicts banner. Continuing or aborting that banner must, for an AI plan
 * with more than one step, resume or unwind the *whole* plan rather than
 * just the single paused `git rebase -i` invocation — this module tracks a
 * pending session per repository so the existing `git.rebase.continue` /
 * `git.rebase.abort` IPC handlers can transparently resume or unwind a
 * multi-step apply (see the small interception in src/main/ipc.ts).
 */
import type { OperationOutcome } from '@shared/ipc';
import type { RebasePlan, RebaseApplyProgress } from '@shared/types';
import { buildExecutionPlan, remapShas, type ReorderMove, type TrackedCommit } from '../ai/rebase-plan-core';
import { GitError, type GitClient } from './git';
import { dropCommit, rebaseAbort, rebaseContinue, reorderCommits, rewordCommit, squashCommits } from './operations';

const FIELD = '\x1f';
const RECORD = '\x1e';

type AtomicStep =
  | { kind: 'drop'; sha: string }
  | { kind: 'reword'; sha: string; message: string }
  | { kind: 'reorder'; move: ReorderMove }
  | { kind: 'squash'; targetSha: string; fixupShas: string[]; message: string };

function phaseOf(step: AtomicStep): RebaseApplyProgress['phase'] {
  return step.kind === 'reorder' ? 'reorder' : step.kind;
}

function describe(step: AtomicStep): string {
  switch (step.kind) {
    case 'drop':
      return `Dropping ${step.sha.slice(0, 7)}`;
    case 'reword':
      return `Rewording ${step.sha.slice(0, 7)}`;
    case 'reorder':
      return `Reordering ${step.move.shas.length} commit${step.move.shas.length === 1 ? '' : 's'}`;
    case 'squash':
      return `Squashing ${step.fixupShas.length} commit${step.fixupShas.length === 1 ? '' : 's'} into ${step.targetSha.slice(0, 7)}`;
  }
}

function buildSteps(plan: RebasePlan, originalOrder: string[]): AtomicStep[] {
  const exec = buildExecutionPlan(originalOrder, plan.rows);
  const steps: AtomicStep[] = [];
  for (const sha of exec.drops) steps.push({ kind: 'drop', sha });
  for (const r of exec.rewords) steps.push({ kind: 'reword', sha: r.sha, message: r.message });
  for (const move of exec.reorderMoves) steps.push({ kind: 'reorder', move });
  for (const g of exec.squashGroups) steps.push({ kind: 'squash', targetSha: g.targetSha, fixupShas: g.fixupShas, message: g.message });
  return steps;
}

/** Fresh oldest-first (sha, author date, full message) for every commit in `base..HEAD`, used to remap identities to their current sha before each step. */
async function fetchLiveCommits(git: GitClient, repoPath: string, base: string): Promise<{ sha: string; authorDate: string; message: string }[]> {
  const out = await git.stdout(repoPath, ['log', '--reverse', `--format=%H${FIELD}%aI${FIELD}%B%x1e`, `${base}..HEAD`], { readOnly: true });
  const commits: { sha: string; authorDate: string; message: string }[] = [];
  for (const record of out.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const [sha, authorDate, ...rest] = trimmed.split(FIELD);
    commits.push({ sha, authorDate, message: rest.join(FIELD).replace(/\n+$/, '') });
  }
  return commits;
}

/** Applies a single atomic step given a sha remap; returns the step's OperationOutcome. */
async function executeStep(git: GitClient, repoPath: string, step: AtomicStep, map: Map<string, string>): Promise<OperationOutcome> {
  switch (step.kind) {
    case 'drop':
      return dropCommit(git, repoPath, map.get(step.sha)!);
    case 'reword':
      return rewordCommit(git, repoPath, map.get(step.sha)!, step.message);
    case 'reorder':
      return reorderCommits(git, repoPath, step.move.shas.map((s) => map.get(s)!), step.move.anchor === null ? null : map.get(step.move.anchor)!);
    case 'squash': {
      const targetSha = map.get(step.targetSha)!;
      return squashCommits(git, repoPath, { targetSha, shas: [targetSha, ...step.fixupShas.map((s) => map.get(s)!)], message: step.message });
    }
  }
}

/** Updates the in-memory identity tracker to reflect a step that has just completed, so the next step's remap has correct fallback ordering and up-to-date expected messages. */
function advanceIdentities(identities: TrackedCommit[], step: AtomicStep): TrackedCommit[] {
  switch (step.kind) {
    case 'drop':
      return identities.filter((t) => t.id !== step.sha);
    case 'reword':
      return identities.map((t) => (t.id === step.sha ? { ...t, message: step.message } : t));
    case 'reorder': {
      const moving = new Set(step.move.shas);
      const group = identities.filter((t) => moving.has(t.id));
      const rest = identities.filter((t) => !moving.has(t.id));
      if (step.move.anchor === null) return [...rest, ...group];
      const anchorIdx = rest.findIndex((t) => t.id === step.move.anchor);
      return [...rest.slice(0, anchorIdx + 1), ...group, ...rest.slice(anchorIdx + 1)];
    }
    case 'squash': {
      const fixups = new Set(step.fixupShas);
      return identities.filter((t) => !fixups.has(t.id)).map((t) => (t.id === step.targetSha ? { ...t, message: step.message } : t));
    }
  }
}

export interface PendingRebaseApply {
  planId: string;
  startSha: string;
  base: string;
}

interface Session extends PendingRebaseApply {
  identities: TrackedCommit[];
  remaining: AtomicStep[];
  total: number;
  onProgress: (e: RebaseApplyProgress) => void;
}

/**
 * Runs (or resumes) a queue of atomic steps against real git, remapping
 * identities to live shas before each one. Stops and returns 'conflicts' on
 * the first step that pauses a rebase, after recording a resumable session;
 * stops and hard-resets to `startSha` if an identity cannot be resolved
 * (the counts no longer match what the plan expects).
 */
async function runSteps(git: GitClient, repoPath: string, session: Session, sessions: Map<string, Session>): Promise<OperationOutcome> {
  let identities = session.identities;
  const doneCount = session.total - session.remaining.length;
  for (let i = 0; i < session.remaining.length; i++) {
    const step = session.remaining[i];
    const live = await fetchLiveCommits(git, repoPath, session.base);
    const map = remapShas(identities, live);
    if (!map) {
      await git.tryRun(repoPath, ['rebase', '--abort']);
      await git.run(repoPath, ['reset', '--hard', session.startSha]);
      sessions.delete(repoPath);
      throw new GitError({
        message: 'A commit expected by the plan could not be found; the branch was restored to its state before Apply.',
        command: 'git rebase -i',
        exitCode: null,
        stderr: '',
        stdout: '',
        code: 'unknown',
      });
    }
    session.onProgress({ planId: session.planId, step: doneCount + i + 1, total: session.total, phase: phaseOf(step), message: describe(step) });
    const outcome = await executeStep(git, repoPath, step, map);
    if (outcome.status === 'conflicts') {
      sessions.set(repoPath, { ...session, identities: advanceIdentities(identities, step), remaining: session.remaining.slice(i + 1) });
      session.onProgress({ planId: session.planId, step: doneCount + i + 1, total: session.total, phase: 'conflicts', message: 'Conflicts need resolving before the rest of the plan can apply.' });
      return { status: 'conflicts' };
    }
    identities = advanceIdentities(identities, step);
  }
  sessions.delete(repoPath);
  session.onProgress({ planId: session.planId, step: session.total, total: session.total, phase: 'done', message: 'Done' });
  return { status: 'complete' };
}

/**
 * Tracks, per repository, the remaining steps of an AI rebase plan whose
 * apply paused on a conflict, so the standard conflicts banner's Continue
 * and Abort can transparently resume or fully unwind the plan (see the
 * `git.rebase.continue` / `git.rebase.abort` handlers in src/main/ipc.ts).
 */
export class RebaseApplyService {
  private sessions = new Map<string, Session>();

  hasPendingApply(repoPath: string): boolean {
    return this.sessions.has(repoPath);
  }

  pendingApply(repoPath: string): PendingRebaseApply | null {
    const s = this.sessions.get(repoPath);
    return s ? { planId: s.planId, startSha: s.startSha, base: s.base } : null;
  }

  async apply(git: GitClient, repoPath: string, plan: RebasePlan, onProgress: (e: RebaseApplyProgress) => void): Promise<OperationOutcome> {
    this.sessions.delete(repoPath);
    const startSha = (await git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
    const live = await fetchLiveCommits(git, repoPath, plan.base);
    const liveShas = new Set(live.map((c) => c.sha));
    const planShas = new Set(plan.rows.map((r) => r.sha));
    if (liveShas.size !== planShas.size || [...planShas].some((sha) => !liveShas.has(sha))) {
      throw new GitError({ message: 'The branch changed since this plan was made. Re-propose the plan.', command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
    }
    const originalOrder = live.map((c) => c.sha);
    const identities: TrackedCommit[] = live.map((c) => ({ id: c.sha, authorDate: c.authorDate, message: c.message }));
    const steps = buildSteps(plan, originalOrder);
    if (!steps.length) {
      onProgress({ planId: plan.id, step: 0, total: 0, phase: 'done', message: 'Nothing to apply' });
      return { status: 'complete' };
    }
    const session: Session = { planId: plan.id, startSha, base: plan.base, identities, remaining: steps, total: steps.length, onProgress };
    return runSteps(git, repoPath, session, this.sessions);
  }

  /** Resumes a paused plan: finishes the currently-paused git rebase step, then continues with the plan's remaining steps. */
  async continueApply(git: GitClient, repoPath: string, unsigned: boolean): Promise<OperationOutcome> {
    const session = this.sessions.get(repoPath);
    if (!session) throw new Error('No AI rebase apply is pending for this repository.');
    const outcome = await rebaseContinue(git, repoPath, unsigned);
    if (outcome.status !== 'complete') return outcome; // still conflicted (or another signing pause): session stays as-is
    return runSteps(git, repoPath, session, this.sessions);
  }

  /** Aborts the currently-paused git rebase and hard-resets the branch all the way back to the plan's recorded start commit, undoing every step already applied. */
  async abortApply(git: GitClient, repoPath: string): Promise<void> {
    const session = this.sessions.get(repoPath);
    if (!session) throw new Error('No AI rebase apply is pending for this repository.');
    await rebaseAbort(git, repoPath).catch(() => undefined);
    await git.run(repoPath, ['reset', '--hard', session.startSha]);
    this.sessions.delete(repoPath);
  }

  /**
   * Resets the branch to `startSha`, only ever called after a successful
   * apply (post-completion Undo), not for the mid-apply abort path above.
   * Unlike a normal history rewrite that only ever adds commits on top of a
   * known-good ancestor, applying a plan replaces the branch's tip
   * entirely, so `startSha` is never an ancestor of the post-apply HEAD;
   * the only safety checks that make sense here are that the working tree
   * is clean and that the (dangling, but not yet garbage-collected) start
   * commit still exists.
   */
  async undo(git: GitClient, repoPath: string, startSha: string): Promise<void> {
    const statusOut = await git.stdout(repoPath, ['status', '--porcelain'], { readOnly: true });
    if (statusOut.trim()) throw new Error('The working tree has uncommitted changes; commit or discard them before undoing.');
    const head = (await git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
    if (head === startSha) return;
    const exists = (await git.tryRun(repoPath, ['cat-file', '-e', `${startSha}^{commit}`], { readOnly: true })) !== null;
    if (!exists) throw new Error('The repository has changed since this plan was applied; undo is no longer available.');
    await git.run(repoPath, ['reset', '--hard', startSha]);
  }
}
