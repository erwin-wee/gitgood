/**
 * Renderer-side orchestration for the AI command palette
 * (add-ai-command-palette). Built-in action matching and running happens
 * entirely in CommandPalette.tsx (it already has `handleMenuAction` in
 * scope); this module owns the "Ask AI" round trip: requesting a plan,
 * the one-round clarifying question, and running a confirmed plan step by
 * step through the existing confirmation dialogs.
 */
import type { NlPlan, NlStep } from '@shared/types';
import { errorInfo, errorMessage, invoke } from '../api';
import { openDialog, patchNlPalette, showToast, store, type NlPaletteHistoryEntry } from './store';

const MAX_HISTORY = 20;

function newHistoryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Opens the palette. `text`, when given (e.g. from a smoke test or a re-run from history), is put straight into the query and submitted to the model, as if the user had typed it and pressed the "Ask AI" row. */
export function openCommandPalette(text?: string): void {
  const repo = store.get().currentRepo;
  if (!repo) {
    showToast({ kind: 'info', title: 'Open a repository first' });
    return;
  }
  patchNlPalette({ query: text ?? '', loading: false, error: null, plan: null, answerDraft: '', stepPhase: {}, completed: [], failedStep: null });
  openDialog({ kind: 'command-palette' });
  if (text && text.trim()) void askPaletteAi(text.trim());
}

export function setPaletteQuery(query: string): void {
  patchNlPalette({ query });
}

export function setPaletteAnswerDraft(answerDraft: string): void {
  patchNlPalette({ answerDraft });
}

/** Returns from a shown plan (or a rejected "too many steps" message) back to the palette's input screen, without closing the dialog. */
export function resetPalettePlan(): void {
  patchNlPalette({ plan: null, error: null, answerDraft: '', stepPhase: {}, completed: [], failedStep: null });
}

/** Sends `request` to the model (fresh round, no prior question). */
export async function askPaletteAi(request: string): Promise<void> {
  const repo = store.get().currentRepo;
  if (!repo || !request.trim()) return;
  patchNlPalette({ loading: true, error: null, plan: null, answerDraft: '', stepPhase: {}, completed: [], failedStep: null });
  try {
    const plan = await invoke('ai.nl.plan', repo.path, request.trim(), null, null);
    patchNlPalette({ loading: false, plan });
  } catch (err) {
    patchNlPalette({ loading: false, error: errorMessage(err) });
  }
}

/** Sends the answer to the palette's one allowed clarifying question, replacing the plan. */
export async function answerPaletteQuestion(): Promise<void> {
  const repo = store.get().currentRepo;
  const { plan, answerDraft } = store.get().nlPalette;
  if (!repo || !plan?.clarifyingQuestion || !answerDraft.trim()) return;
  patchNlPalette({ loading: true, error: null });
  try {
    const next = await invoke('ai.nl.plan', repo.path, plan.request, plan.clarifyingQuestion, answerDraft.trim());
    patchNlPalette({ loading: false, plan: next, answerDraft: '', stepPhase: {}, completed: [], failedStep: null });
  } catch (err) {
    patchNlPalette({ loading: false, error: errorMessage(err) });
  }
}

export function cancelPaletteRequest(): void {
  void invoke('ai.cancel');
  patchNlPalette({ loading: false });
}

export function copyPlanCommands(steps: NlStep[]): void {
  const text = steps.map((s) => `git ${s.display}`).join('\n');
  void invoke('app.clipboard.write', text).then(() => showToast({ kind: 'success', title: 'Commands copied' }));
}

function riskLabel(step: NlStep): string {
  switch (step.risk) {
    case 'discards-work':
      return 'This can permanently discard uncommitted or stashed work.';
    case 'touches-remote':
      return 'This publishes to or overwrites a remote branch or tag.';
    case 'changes-history':
      return 'This rewrites or moves commits on this branch.';
    default:
      return '';
  }
}

/** Records/updates the in-memory history entry for the plan currently being run, capped at 20 (oldest dropped first). */
function upsertHistory(plan: NlPlan, completed: string[], failedStep: string | null, cancelled: boolean): void {
  patchNlPalette((p) => {
    const existing = p.history.find((h) => h.id === plan.id);
    const entry: NlPaletteHistoryEntry = { id: plan.id, request: plan.request, steps: plan.steps, ranAt: existing?.ranAt ?? Date.now(), completed, failedStep, cancelled };
    const rest = p.history.filter((h) => h.id !== plan.id);
    return { history: [entry, ...rest].slice(0, MAX_HISTORY) };
  });
}

/** Runs one step through `ai.nl.run`, updating the live plan card's per-step phase. Returns whether it succeeded. */
async function executeStep(repoPath: string, plan: NlPlan, step: NlStep): Promise<boolean> {
  patchNlPalette((p) => ({ stepPhase: { ...p.stepPhase, [step.id]: 'running' } }));
  try {
    const result = await invoke('ai.nl.run', repoPath, plan, [step.id]);
    if (result.failedStep) {
      const message = result.error?.message ?? 'The step failed.';
      patchNlPalette((p) => ({ stepPhase: { ...p.stepPhase, [step.id]: 'error' }, failedStep: step.id }));
      showToast({ kind: 'error', title: 'Command palette step failed', message });
      upsertHistory(plan, store.get().nlPalette.completed, step.id, false);
      return false;
    }
    patchNlPalette((p) => ({ stepPhase: { ...p.stepPhase, [step.id]: 'done' }, completed: [...p.completed, step.id] }));
    return true;
  } catch (err) {
    const info = errorInfo(err);
    patchNlPalette((p) => ({ stepPhase: { ...p.stepPhase, [step.id]: 'error' }, failedStep: step.id }));
    showToast({ kind: 'error', title: 'Command palette step failed', message: info.message });
    upsertHistory(plan, store.get().nlPalette.completed, step.id, false);
    return false;
  }
}

/** Runs `plan.steps` in order starting at `index`. Executable "safe" steps run immediately; anything riskier opens the same confirmation dialog GitGood already uses for a manual destructive action (see runPaletteConfirmDialogFor) and only continues on Confirm — a Cancel simply never calls the continuation, which is exactly spec.md's "stop the plan and list the completed steps". */
async function runFrom(repoPath: string, plan: NlPlan, index: number, chain = true): Promise<void> {
  if (index >= plan.steps.length) {
    upsertHistory(plan, store.get().nlPalette.completed, null, false);
    return;
  }
  const step = plan.steps[index];
  if (!step.executable) return chain ? runFrom(repoPath, plan, index + 1, chain) : undefined;

  const proceed = async () => {
    const ok = await executeStep(repoPath, plan, step);
    if (ok && chain) await runFrom(repoPath, plan, index + 1, chain);
    else if (ok) upsertHistory(plan, store.get().nlPalette.completed, null, false);
  };

  if (step.risk === 'safe') {
    await proceed();
    return;
  }

  openDialog({
    kind: 'confirm',
    title: 'Run this step?',
    message: [`git ${step.display}`, step.explanation, riskLabel(step), step.preview ? `${step.preview.title}:\n${step.preview.lines.join('\n')}` : null].filter(Boolean).join('\n\n'),
    confirmLabel: 'Run step',
    danger: step.risk !== 'changes-history',
    // ConfirmDialog already closes itself before awaiting onConfirm, so closing
    // again here would pop the palette off the stack too and hide the plan card,
    // the per-step progress and the steps still to run.
    onConfirm: () => {
      void proceed();
    },
  });
}

/** "Run plan": starts (or resumes, after a step failed and was fixed by hand) sequential execution from the first not-yet-completed step. */
export function runPalettePlan(): void {
  const repo = store.get().currentRepo;
  const { plan, completed } = store.get().nlPalette;
  if (!repo || !plan || !plan.steps.length) return;
  patchNlPalette({ failedStep: null });
  const startIndex = plan.steps.findIndex((s) => !completed.includes(s.id));
  void runFrom(repo.path, plan, startIndex === -1 ? plan.steps.length : startIndex);
}

/** Runs exactly one step immediately (used by tests/automation and by a per-row "Run" action); still opens the confirmation dialog for anything riskier than "safe". */
export function runPaletteStep(stepId: string): void {
  const repo = store.get().currentRepo;
  const { plan } = store.get().nlPalette;
  if (!repo || !plan) return;
  const index = plan.steps.findIndex((s) => s.id === stepId);
  if (index === -1) return;
  void runFrom(repo.path, plan, index, false);
}

/** Re-runs a request from a history entry, as a fresh plan (never replays stale step ids). */
export function rerunFromHistory(entry: NlPaletteHistoryEntry): void {
  void askPaletteAi(entry.request);
}
