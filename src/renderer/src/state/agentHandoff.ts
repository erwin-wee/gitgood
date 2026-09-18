import type { ReviewRun } from '@shared/types';
import { AGENT_PRESETS } from '@shared/agent-presets';
import { pathsEqual } from '@shared/util';
import { invoke, isMac } from '../api';
import { openRepository, showError, updateSettings } from './actions';
import { reviewChangesBeforeCommit } from './precommitReview';
import { openDialog, showToast, store } from './store';

// ---------------------------------------------------------------------------
// Handing review findings to a terminal coding agent (Claude Code, Codex,
// omp, …): the "Fix with agent" button and the gitgood://review/rerun deep
// link the agent opens when it is done.
// ---------------------------------------------------------------------------

/** Whether the Fix with agent action should be shown for this run: provider on and at least one live finding. */
export function agentHandoffAvailable(run: ReviewRun | null): boolean {
  const s = store.get();
  return !!run && !!s.currentRepo && s.settings?.ai.provider !== 'disabled' && run.findings.some((f) => !f.dismissed);
}

function agentLabel(): string {
  const ai = store.get().settings?.ai;
  if (!ai) return 'the agent';
  if (ai.agentCommand === 'custom') return 'your custom agent command';
  return AGENT_PRESETS.find((p) => p.id === ai.agentCommand)?.label ?? 'the agent';
}

async function launchAgent(repoPath: string, run: ReviewRun): Promise<void> {
  try {
    const { launched, command } = await invoke('ai.review.fixWithAgent', repoPath, run.id);
    if (launched) showToast({ kind: 'success', title: `${agentLabel()} started in your terminal`, message: 'The findings were written to the repository\'s git directory. Nothing is committed; review the agent\'s edits before you commit.' }, 8000);
    else showToast({ kind: 'info', title: 'Command copied to the clipboard', message: `Your terminal cannot start a command directly. Paste to start ${agentLabel()}:\n${command}`, sticky: true });
  } catch (err) {
    showError('Could not start the agent', err);
  }
}

/** "Fix with agent": exports the run for the agent and opens the terminal running the configured agent command. Shows a one-time notice about what is handed over first. */
export async function fixWithAgent(run: ReviewRun): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  if (!repo || !s.settings) return;
  if (!agentHandoffAvailable(run)) return;
  if (s.settings.ai.agentHandoffNoticeShown) {
    await launchAgent(repo.path, run);
    return;
  }
  const loop = run.target.kind === 'worktree'
    ? 'The agent edits files in the working tree; nothing is committed. When it finishes it asks GitGood to re-review so you can see what was fixed.'
    : 'The agent edits files in the working tree; nothing is committed. This review covers committed changes, so commit the agent\'s edits and press Re-review to confirm them.';
  openDialog({
    kind: 'confirm',
    title: `Hand these findings to ${agentLabel()}?`,
    message: [
      'GitGood writes the review findings, including the suggested code and the excerpts the reviewer flagged, into the repository\'s git directory and opens your terminal running the agent on them.',
      loop,
      'You can change the agent under Options → AI → Agent for fixes.',
    ].join('\n\n'),
    confirmLabel: 'Open terminal',
    onConfirm: async () => {
      // Read the settings again: the user may have changed one while the notice was open.
      const current = store.get().settings?.ai ?? s.settings!.ai;
      await updateSettings({ ai: { ...current, agentHandoffNoticeShown: true } });
      await launchAgent(repo.path, run);
    },
  });
}

function samePathHere(a: string, b: string): boolean {
  // Windows and macOS file systems ignore case by default, so a link whose path
  // is spelled differently still matches the repository.
  return pathsEqual(a, b, isMac || window.gitgoodBridge.platform === 'win32');
}

async function waitForStatus(repoPath: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const s = store.get();
    if (s.currentRepo?.path === repoPath && s.status) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * The `gitgood://review/rerun?repo=…` deep link: re-runs the most recent
 * review for that repository. Every refusal is explained in a toast and
 * starts nothing. Exposed on window.__gitgood.actions for smoke tests.
 */
export async function handleProtocolReviewRerun(args: { repoPath: string }): Promise<void> {
  const s = store.get();
  const match = s.repos.find((r) => !r.missing && samePathHere(r.path, args.repoPath));
  if (!match) {
    showToast({ kind: 'info', title: 'Re-review requested for a repository that is not open in GitGood', message: args.repoPath });
    return;
  }
  if (!s.settings || s.settings.ai.provider === 'disabled') {
    showToast({ kind: 'info', title: 'AI features are turned off', message: 'Enable a provider under Options → AI to re-review.', action: { label: 'Options', onClick: () => openDialog({ kind: 'settings', tab: 'ai' }) } });
    return;
  }
  if (s.currentRepo?.path !== match.path) await openRepository(match);
  if (!(await waitForStatus(match.path))) {
    showToast({ kind: 'warning', title: 'Could not open the repository for re-review', message: match.path });
    return;
  }
  const now = store.get();
  if (now.review.running || now.precommitReview.running) {
    showToast({ kind: 'info', title: 'A review is already running', message: 'The re-review request was ignored; the running review continues.' });
    return;
  }
  let latest: ReviewRun | null;
  try {
    latest = await invoke('ai.review.latest', match.path);
  } catch (err) {
    showError('Could not look up the last review', err);
    return;
  }
  if (!latest) {
    showToast({ kind: 'info', title: 'Nothing to re-review', message: 'This repository has no completed AI review yet.' });
    return;
  }
  // A review can start while the lookup above is in flight.
  if (store.get().review.running || store.get().precommitReview.running) {
    showToast({ kind: 'info', title: 'A review is already running', message: 'The re-review request was ignored; the running review continues.' });
    return;
  }
  if (latest.target.kind !== 'worktree') {
    // Pull request and branch reviews read committed history, so re-running one
    // over the agent's uncommitted edits would report exactly the same findings.
    showToast({
      kind: 'info',
      title: 'Commit the fixes to re-review this ' + (latest.target.kind === 'pr' ? 'pull request' : 'branch'),
      message: 'That review covers committed changes, so it cannot see edits that are still in the working tree.',
      action: { label: 'Review pending changes', onClick: () => void reviewChangesBeforeCommit() },
    }, 12000);
    return;
  }
  await reviewChangesBeforeCommit();
}
