/**
 * The fixed set of actions an AI-suggested error fix may name. This is the
 * only execution surface AI error explanation gets: the model may only name
 * one of these ids (see error-explain-core.ts's validateFixes), and each one
 * maps onto an operation GitGood already exposes elsewhere in the UI, run
 * through the renderer's normal action functions and their confirmations
 * (see applyErrorFix in src/renderer/src/state/actions.ts). No Electron or
 * Node imports, so the table and its applicability rules can be unit tested
 * directly.
 */
import type { FixActionId, FixRisk, RepositoryStatus } from '@shared/types';

export interface FixActionDef {
  id: FixActionId;
  label: string;
  /** One-line description of what the action does, shown to the model in the prompt so it can pick sensibly. */
  description: string;
  /** The action's own risk classification; the fix actually shown uses the higher of this and the model's own classification (see riskMax). */
  risk: FixRisk;
  /**
   * Whether this action is valid for the current repository state.
   * `status` is null when it could not be read (or the repository is not
   * open at all, e.g. a clone failure); `hasRepo` is true whenever a
   * repository path is known at all, even if `status` itself is null.
   */
  appliesTo(status: RepositoryStatus | null, hasRepo: boolean): boolean;
}

const RISK_RANK: Record<FixRisk, number> = { safe: 0, 'changes-history': 1, 'discards-work': 2, 'touches-remote': 3 };

/** The higher (more destructive) of two risk classifications. */
export function riskMax(a: FixRisk, b: FixRisk): FixRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export function compareRisk(a: FixRisk, b: FixRisk): number {
  return RISK_RANK[a] - RISK_RANK[b];
}

function opKind(status: RepositoryStatus | null): RepositoryStatus['operation']['kind'] {
  return status?.operation.kind ?? 'none';
}

export const FIX_ACTIONS: readonly FixActionDef[] = [
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch from the remote without changing any local branch.',
    risk: 'safe',
    appliesTo: (_status, hasRepo) => hasRepo,
  },
  {
    id: 'pull',
    label: 'Pull',
    description: 'Fetch and integrate the current branch\'s upstream. Requires an upstream to already be configured.',
    risk: 'safe',
    appliesTo: (status, hasRepo) => hasRepo && !!status && !!status.branch.upstream && opKind(status) === 'none',
  },
  {
    id: 'fetch-and-pull',
    label: 'Fetch, then pull',
    description: 'Fetch from the remote, then pull the current branch\'s upstream. Requires an upstream to already be configured.',
    risk: 'safe',
    appliesTo: (status, hasRepo) => hasRepo && !!status && !!status.branch.upstream && opKind(status) === 'none',
  },
  {
    id: 'push-set-upstream',
    label: 'Push and set upstream',
    description: 'Publish the current branch, creating and tracking a matching branch on the remote. Only valid when the branch has no upstream (or its upstream is gone).',
    risk: 'touches-remote',
    appliesTo: (status, hasRepo) => hasRepo && !!status && !status.branch.detached && !status.branch.unborn && (!status.branch.upstream || status.branch.upstreamGone),
  },
  {
    id: 'force-push-with-lease',
    label: 'Force push (with lease)',
    description: 'Force-push the current branch with --force-with-lease, behind the app\'s force-push confirmation. Only valid when the branch already has an upstream.',
    risk: 'touches-remote',
    appliesTo: (status, hasRepo) => hasRepo && !!status && !status.branch.detached && !!status.branch.upstream,
  },
  {
    id: 'stash-and-retry',
    label: 'Stash changes',
    description: 'Stash uncommitted changes so the failed operation can run cleanly. Only valid when there are uncommitted changes.',
    risk: 'safe',
    appliesTo: (status, hasRepo) => hasRepo && !!status && status.files.length > 0,
  },
  {
    id: 'discard-and-retry',
    label: 'Discard changes',
    description: 'Discard uncommitted changes so the failed operation can run cleanly. Only valid when there are uncommitted changes; this destroys the discarded work.',
    risk: 'discards-work',
    appliesTo: (status, hasRepo) => hasRepo && !!status && status.files.length > 0,
  },
  {
    id: 'remove-lock-file',
    label: 'Remove stale lock file',
    description: 'Delete .git/index.lock. Refused when a git process is currently running or the lock is less than 10 seconds old.',
    risk: 'safe',
    appliesTo: (_status, hasRepo) => hasRepo,
  },
  {
    id: 'abort-merge',
    label: 'Abort merge',
    description: 'Abort the in-progress merge and return to the pre-merge state. Only valid during a merge.',
    risk: 'discards-work',
    appliesTo: (status, hasRepo) => hasRepo && opKind(status) === 'merge',
  },
  {
    id: 'abort-rebase',
    label: 'Abort rebase',
    description: 'Abort the in-progress rebase and return to the pre-rebase state. Only valid during a rebase.',
    risk: 'discards-work',
    appliesTo: (status, hasRepo) => hasRepo && opKind(status) === 'rebase',
  },
  {
    id: 'abort-cherry-pick',
    label: 'Abort cherry-pick',
    description: 'Abort the in-progress cherry-pick. Only valid during a cherry-pick.',
    risk: 'discards-work',
    appliesTo: (status, hasRepo) => hasRepo && opKind(status) === 'cherry-pick',
  },
  {
    id: 'abort-revert',
    label: 'Abort revert',
    description: 'Abort the in-progress revert. Only valid during a revert.',
    risk: 'discards-work',
    appliesTo: (status, hasRepo) => hasRepo && opKind(status) === 'revert',
  },
  {
    id: 'continue-rebase',
    label: 'Continue rebase',
    description: 'Continue the in-progress rebase after conflicts have been resolved and staged. Only valid during a rebase.',
    risk: 'changes-history',
    appliesTo: (status, hasRepo) => hasRepo && opKind(status) === 'rebase',
  },
  {
    id: 'open-sign-in',
    label: 'Sign in to GitHub',
    description: 'Open the GitHub sign-in dialog. Always valid, even before a repository is open.',
    risk: 'safe',
    appliesTo: () => true,
  },
  {
    id: 'open-remote-settings',
    label: 'Open remote settings',
    description: "Open the repository's remote settings.",
    risk: 'safe',
    appliesTo: (_status, hasRepo) => hasRepo,
  },
  {
    id: 'open-identity-settings',
    label: 'Open identity settings',
    description: "Open the repository's commit identity (name/email) settings.",
    risk: 'safe',
    appliesTo: (_status, hasRepo) => hasRepo,
  },
  {
    id: 'rename-branch',
    label: 'Rename current branch',
    description: 'Open the rename-branch dialog for the current branch. Only valid when a branch is checked out (not detached).',
    risk: 'safe',
    appliesTo: (status, hasRepo) => hasRepo && !!status && !!status.branch.name && !status.branch.detached,
  },
  {
    id: 'open-in-terminal',
    label: 'Open in terminal',
    description: 'Open a terminal at the repository, without running anything.',
    risk: 'safe',
    appliesTo: (_status, hasRepo) => hasRepo,
  },
] as const;

const FIX_ACTIONS_BY_ID: ReadonlyMap<FixActionId, FixActionDef> = new Map(FIX_ACTIONS.map((a) => [a.id, a]));

export function getFixAction(id: string): FixActionDef | null {
  return FIX_ACTIONS_BY_ID.get(id as FixActionId) ?? null;
}
