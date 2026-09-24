import React, { useState } from 'react';
import type { NlRisk, NlStep } from '@shared/types';
import * as actions from '../state/actions';
import { closeDialog, useAppStore, type NlPaletteHistoryEntry } from '../state/store';
import { Badge, Button, Dialog, Icon, Spinner, useFilter, type IconName } from './ui';

/**
 * Built-in actions offered before any AI call, mirrored from the ids and
 * labels `handleMenuAction`/`src/main/menu.ts` already use (see
 * openspec/changes/add-ai-command-palette). Selecting one just calls
 * `handleMenuAction` directly — no AI is ever involved for these.
 */
const BUILTIN_ACTIONS: { id: string; label: string }[] = [
  { id: 'push', label: 'Push' },
  { id: 'pull', label: 'Pull' },
  { id: 'fetch', label: 'Fetch' },
  { id: 'new-branch', label: 'New Branch…' },
  { id: 'rename-branch', label: 'Rename Branch…' },
  { id: 'delete-branch', label: 'Delete Branch…' },
  { id: 'discard-all-changes', label: 'Discard All Changes…' },
  { id: 'stash-all-changes', label: 'Stash All Changes' },
  { id: 'show-stashes', label: 'Stashes' },
  { id: 'update-from-default', label: 'Update from Default Branch' },
  { id: 'compare-branch', label: 'Compare to Branch' },
  { id: 'merge-branch', label: 'Merge into Current Branch…' },
  { id: 'squash-merge-branch', label: 'Squash and Merge into Current Branch…' },
  { id: 'rebase-branch', label: 'Rebase Current Branch…' },
  { id: 'create-pull-request', label: 'Create Pull Request' },
  { id: 'view-pull-request', label: 'View Pull Request on GitHub' },
  { id: 'review-branch', label: 'Review Branch with AI…' },
  { id: 'review-pull-request', label: 'Review Pull Request with AI…' },
  { id: 'draft-pull-request-ai', label: 'Draft Pull Request with AI…' },
  { id: 'tidy-branch-ai', label: 'Tidy Up Branch with AI…' },
  { id: 'split-commits', label: 'Split into Commits with AI…' },
  { id: 'release-notes', label: 'Release Notes…' },
  { id: 'show-worktrees', label: 'Worktrees…' },
  { id: 'show-submodules', label: 'Submodules…' },
  { id: 'show-lfs', label: 'Git LFS…' },
  { id: 'show-health', label: 'Repository Health…' },
  { id: 'show-issues', label: 'Issues…' },
  { id: 'create-issue', label: 'Create Issue on GitHub' },
  { id: 'view-on-github', label: 'View on GitHub' },
  { id: 'compare-on-github', label: 'Compare on GitHub' },
  { id: 'open-in-shell', label: 'Open in Terminal' },
  { id: 'open-in-editor', label: 'Open in External Editor' },
  { id: 'show-in-folder', label: 'Show in File Manager' },
  { id: 'repository-settings', label: 'Repository Settings…' },
  { id: 'show-changes', label: 'Changes' },
  { id: 'show-history', label: 'History' },
  { id: 'settings', label: 'Settings…' },
];

const EXAMPLE_PROMPTS = ['Create a branch called feature/login', 'Squash the last 3 commits', 'Review my changes', 'Split these changes into focused commits'];
const RISK_TONE: Record<NlRisk, 'neutral' | 'attention' | 'danger'> = { safe: 'neutral', 'changes-history': 'attention', 'discards-work': 'danger', 'touches-remote': 'danger' };
const RISK_LABEL: Record<NlRisk, string> = { safe: 'safe', 'changes-history': 'changes history', 'discards-work': 'discards work', 'touches-remote': 'touches remote' };
const STEP_ICON: Record<'running' | 'done' | 'error', IconName> = { running: 'sync', done: 'check-circle', error: 'x-circle' };

/** True only for the synthetic "too many steps" message the planner puts in `clarifyingQuestion` when the model returned more than 8 steps (see nlPalette.ts's plan()); that message needs no answer box, unlike a real clarifying question. */
function isTooManyStepsMessage(question: string): boolean {
  return question.startsWith('That request needs more than 8 steps');
}

function StepRow({ step, phase }: { step: NlStep; phase: 'running' | 'done' | 'error' | undefined }): React.JSX.Element {
  return (
    <li className={`nl-step ${step.executable ? '' : 'nl-step-copy-only'}`}>
      <div className="nl-step-head">
        {phase ? <Icon name={STEP_ICON[phase]} /> : null}
        <code className="mono">git {step.display}</code>
        <Badge tone={RISK_TONE[step.risk]}>{RISK_LABEL[step.risk]}</Badge>
        {!step.executable ? <Badge tone="neutral">copy only</Badge> : null}
        <Button size="sm" variant="ghost" icon="copy" iconOnly title="Copy command" onClick={() => void actions.copyToClipboard(`git ${step.display}`, 'Command copied')} />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{step.explanation}</p>
      {!step.executable && step.refusalReason ? <p className="nl-step-reason">{step.refusalReason}</p> : null}
      {step.preview ? (
        <details className="nl-step-preview">
          <summary>{step.preview.title}</summary>
          <pre>{step.preview.lines.join('\n') || '(nothing)'}</pre>
        </details>
      ) : null}
    </li>
  );
}

function HistoryEntryRow({ entry }: { entry: NlPaletteHistoryEntry }): React.JSX.Element {
  const outcome = entry.failedStep ? 'failed' : entry.completed.length === entry.steps.filter((s) => s.executable).length && entry.steps.some((s) => s.executable) ? 'completed' : entry.completed.length ? 'partial' : 'not run';
  return (
    <li className="nl-history-entry">
      <div>
        <strong>{entry.request}</strong>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{outcome}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Button size="sm" variant="ghost" icon="copy" onClick={() => actions.copyPlanCommands(entry.steps)}>Copy commands</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.rerunFromHistory(entry)}>Ask again</Button>
      </div>
    </li>
  );
}

export function CommandPalette(): React.JSX.Element {
  const nl = useAppStore((s) => s.nlPalette);
  const settings = useAppStore((s) => s.settings);
  const [showHistory, setShowHistory] = useState(false);
  const aiAvailable = settings?.ai.provider !== 'disabled' && settings?.ai.nlPaletteEnabled !== false;
  const matches = useFilter(BUILTIN_ACTIONS, nl.query, (a) => [a.label, a.id]);

  const onClose = () => {
    if (nl.loading) {
      actions.cancelPaletteRequest();
      return;
    }
    closeDialog();
  };

  const runBuiltin = (id: string) => {
    closeDialog();
    void actions.handleMenuAction(id);
  };

  const askAi = () => {
    if (!nl.query.trim()) return;
    void actions.askPaletteAi(nl.query.trim());
  };

  const executableCount = nl.plan?.steps.filter((s) => s.executable).length ?? 0;
  const allDone = executableCount > 0 && nl.completed.length >= executableCount && !nl.failedStep;

  return (
    <Dialog title="Ask GitGood" icon="sparkle" width="wide" onClose={onClose} className="command-palette-dialog">
      {!nl.plan && !nl.loading ? (
        <>
          <div className="filter-input">
            <Icon name="search" />
            <input
              autoFocus
              type="text"
              value={nl.query}
              placeholder="Type a command, or describe what you want in plain language…"
              onChange={(e) => actions.setPaletteQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (matches.length) runBuiltin(matches[0].id);
                else if (aiAvailable) askAi();
              }}
              spellCheck={false}
            />
          </div>
          {!nl.query.trim() ? (
            <div className="nl-examples">
              <span className="nl-examples-label">Try an example</span>
              <div className="nl-example-list">
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <Button key={prompt} size="sm" variant="ghost" className="nl-example-row" onClick={() => actions.setPaletteQuery(prompt)}>
                    {prompt}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <ul className="nl-builtin-list">
            {matches.map((m) => (
              <li key={m.id}>
                <Button variant="ghost" className="nl-builtin-row" onClick={() => runBuiltin(m.id)}>
                  {m.label}
                </Button>
              </li>
            ))}
            {aiAvailable ? (
              <li>
                <Button variant="ghost" className="nl-builtin-row nl-ask-ai-row" onClick={askAi} disabled={!nl.query.trim()}>
                  <Icon name="sparkle" /> Ask AI: “{nl.query.trim() || '…'}”
                </Button>
              </li>
            ) : null}
          </ul>
          {nl.error ? <p className="nl-step-reason">{nl.error}</p> : null}
          {nl.history.length ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>
                <Icon name="history" /> {showHistory ? 'Hide' : 'Show'} history ({nl.history.length})
              </Button>
              {showHistory ? (
                <ul className="nl-history-list">
                  {nl.history.map((h) => (
                    <HistoryEntryRow key={h.id} entry={h} />
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {nl.loading ? (
        <p>
          <Spinner /> Asking the model… <Button size="sm" variant="ghost" onClick={actions.cancelPaletteRequest}>Cancel</Button>
        </p>
      ) : null}

      {nl.plan && !nl.loading ? (
        nl.plan.clarifyingQuestion ? (
          isTooManyStepsMessage(nl.plan.clarifyingQuestion) ? (
            <>
              <p>{nl.plan.clarifyingQuestion}</p>
              <Button onClick={actions.resetPalettePlan}>Back</Button>
            </>
          ) : (
            <>
              <p><strong>{nl.plan.clarifyingQuestion}</strong></p>
              <textarea rows={3} value={nl.answerDraft} onChange={(e) => actions.setPaletteAnswerDraft(e.target.value)} placeholder="Your answer…" autoFocus />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button variant="primary" disabled={!nl.answerDraft.trim()} onClick={() => void actions.answerPaletteQuestion()}>Answer</Button>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
              </div>
            </>
          )
        ) : (
          <>
            <ol className="nl-step-list">
              {nl.plan.steps.map((s) => (
                <StepRow key={s.id} step={s} phase={nl.stepPhase[s.id]} />
              ))}
            </ol>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {!allDone ? (
                <Button variant="primary" icon="check" disabled={executableCount === 0} onClick={actions.runPalettePlan}>Run plan</Button>
              ) : (
                <Badge tone="success">Plan complete</Badge>
              )}
              <Button variant="ghost" icon="copy" onClick={() => actions.copyPlanCommands(nl.plan!.steps)}>Copy commands</Button>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </div>
          </>
        )
      ) : null}
    </Dialog>
  );
}
