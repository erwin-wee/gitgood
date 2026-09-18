import React, { useState } from 'react';
import type { RebasePlan, RebasePlanAction, RebasePlanRow } from '@shared/types';
import * as actions from '../../state/actions';
import { useAppStore } from '../../state/store';
import { Badge, Button, Callout, Dialog, Icon, Spinner, TextField } from '../ui';

const DND_ROW = 'application/x-gitgood-rebase-row';

const ACTION_LABELS: Record<RebasePlanAction, string> = { pick: 'Pick', squash: 'Squash into', reword: 'Reword', drop: 'Drop' };

// ---------------------------------------------------------------------------
// Pre-flight card (before any AI call)
// ---------------------------------------------------------------------------

function PreflightCard(): React.JSX.Element {
  const rebase = useAppStore((s) => s.rebase);
  const { base, preflight, preflightLoading, preflightError, signingWarning } = rebase;

  return (
    <>
      <p>GitGood will send the commits ahead of the base to the configured AI provider and propose squashing fixups, rewording uninformative messages, reordering related work and dropping empty commits. Nothing is rewritten until you review and click Apply.</p>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <TextField label="Base" value={base} onChange={(e) => actions.setRebaseBase(e.target.value)} onBlur={() => actions.checkRebaseBase()} placeholder="main" style={{ flex: 1 }} />
        <Button size="sm" onClick={() => actions.checkRebaseBase()}>Check</Button>
      </div>
      {preflightLoading ? <p><Spinner /> Checking…</p> : null}
      {preflightError ? <Callout tone="danger">{preflightError}</Callout> : null}
      {!preflightLoading && preflight ? (
        preflight.resolvedBase === null ? (
          <Callout tone="danger">Base "{preflight.base}" was not found. Check the branch name and try again.</Callout>
        ) : (
          <>
            <div className="review-plan-summary">
              <span><strong>{preflight.count}</strong> commit{preflight.count === 1 ? '' : 's'} ahead of {preflight.resolvedBase}</span>
              {preflight.pushedCount > 0 ? <Badge tone="attention">{preflight.pushedCount} already pushed</Badge> : null}
            </div>
            {preflight.hasMergeCommit ? (
              <Callout tone="danger">This range includes a merge commit. GitGood cannot rewrite across a merge; choose a different base or selection.</Callout>
            ) : (
              <>
                {preflight.pushedCount > 0 ? <Callout tone="warning">{preflight.pushedCount} of {preflight.count} commits are already on a remote branch. Applying will require a force push with lease afterward.</Callout> : null}
                {signingWarning ? <Callout tone="warning">Commit signing is enabled for this repository; rewritten commits will lose their signatures.</Callout> : null}
                {preflight.count === 0 ? <Callout tone="info">There are no commits ahead of the base to tidy.</Callout> : null}
              </>
            )}
          </>
        )
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Editable plan rows
// ---------------------------------------------------------------------------

function RowEditor({ row, index, plan }: { row: RebasePlanRow; index: number; plan: RebasePlan }): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false);
  const changed = row.action !== 'pick' || row.message !== row.originalMessage;
  const targets = actions.validSquashTargets(plan, row.sha);

  return (
    <div
      className={`rebase-row ${dragOver ? 'drag-over' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(DND_ROW, String(index))}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_ROW)) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const from = Number(e.dataTransfer.getData(DND_ROW));
        if (!Number.isNaN(from)) actions.reorderRebaseRow(from, index);
      }}
    >
      <Icon name="kebab" size={12} className="muted rebase-drag-handle" title="Drag to reorder" />
      <span className="mono muted" style={{ fontSize: 11 }}>{row.sha.slice(0, 7)}</span>
      <select value={row.action} onChange={(e) => actions.setRebaseRowAction(row.sha, e.target.value as RebasePlanAction)}>
        {(['pick', 'reword', 'squash', 'drop'] as RebasePlanAction[]).map((a) => (
          <option key={a} value={a} disabled={a === 'squash' && !targets.length && row.action !== 'squash'}>
            {ACTION_LABELS[a]}
          </option>
        ))}
      </select>
      {row.action === 'squash' ? (
        <select value={row.squashInto ?? ''} onChange={(e) => actions.setRebaseSquashTarget(row.sha, e.target.value)}>
          {targets.map((t) => (
            <option key={t.sha} value={t.sha}>{t.sha.slice(0, 7)} {t.message.split('\n')[0].slice(0, 40)}</option>
          ))}
        </select>
      ) : null}
      {row.pushed ? <Badge outline title="Already on a remote branch">pushed</Badge> : null}
      <textarea
        className="rebase-message-input"
        value={row.message}
        disabled={row.action === 'drop'}
        onChange={(e) => actions.setRebaseRowMessage(row.sha, e.target.value)}
        rows={row.message.includes('\n') ? 3 : 1}
      />
      {changed ? <Button size="sm" variant="ghost" icon="undo" title="Reset to original" onClick={() => actions.resetRebaseRow(row.sha)} /> : null}
      {row.rationale ? <span className="muted rebase-rationale" title={row.rationale}>{row.rationale}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview (resulting history, oldest last / newest first like History)
// ---------------------------------------------------------------------------

function PreviewResult({ plan }: { plan: RebasePlan }): React.JSX.Element {
  const survivors = plan.rows.filter((r) => r.action !== 'drop' && r.action !== 'squash');
  const newestFirst = [...survivors].reverse();
  return (
    <div className="rebase-preview">
      {newestFirst.map((r) => (
        <div key={r.sha} className="rebase-preview-row">
          <span className="mono muted" style={{ fontSize: 11 }}>{r.sha.slice(0, 7)}</span>
          <span className="truncate">{r.message.split('\n')[0]}</span>
          {r.pushed ? <Badge outline>pushed</Badge> : null}
        </div>
      ))}
      {!newestFirst.length ? <div className="list-empty">Every commit would be dropped.</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply progress
// ---------------------------------------------------------------------------

function ApplyProgressBar(): React.JSX.Element {
  const rebase = useAppStore((s) => s.rebase);
  const p = rebase.applyProgress;
  return (
    <div className="split-apply-progress">
      <Spinner />
      <span>{p?.message ?? 'Applying…'}</span>
      {p ? <span className="muted" style={{ marginLeft: 'auto' }}>{Math.min(p.step, p.total)} of {p.total}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export function TidyBranchDialog(): React.JSX.Element {
  const rebase = useAppStore((s) => s.rebase);
  const { preflight, plan, planLoading, planError, applying, applyError } = rebase;
  const [showPreview, setShowPreview] = useState(false);

  const alreadyTidy = actions.rebaseAlreadyTidy(plan);
  const canApply = actions.canApplyRebasePlan(plan);
  const canPropose = !!preflight && preflight.resolvedBase !== null && !preflight.hasMergeCommit && preflight.count > 0;

  const footer = (
    <>
      <span className="left">{planError || applyError ? <Callout tone="danger" icon="alert">{applyError ?? planError}</Callout> : null}</span>
      {!applying ? <Button onClick={() => actions.closeRebaseDialog()}>Cancel</Button> : null}
      {plan && !alreadyTidy ? (
        <Button variant="ghost" onClick={() => actions.reproposeRebasePlan()} disabled={applying}>Re-propose</Button>
      ) : null}
      {plan && !alreadyTidy ? <Button variant="ghost" onClick={() => actions.resetRebasePlan()} disabled={applying}>Reset all</Button> : null}
      {!plan && !planLoading ? (
        <Button variant="primary" icon="sparkle" onClick={() => void actions.proposeRebasePlan()} disabled={!canPropose}>Propose</Button>
      ) : null}
      {planLoading ? <Button variant="ghost" onClick={() => actions.cancelRebasePropose()}>Cancel proposing</Button> : null}
      {plan && !alreadyTidy ? (
        <Button variant="ghost" onClick={() => setShowPreview((v) => !v)}>{showPreview ? 'Hide preview' : 'Preview result'}</Button>
      ) : null}
      {plan && !alreadyTidy ? (
        <Button variant="primary" icon="squash" loading={applying} disabled={!canApply || applying} onClick={() => void actions.applyRebasePlan()}>Apply</Button>
      ) : null}
    </>
  );

  return (
    <Dialog title="Tidy up branch with AI" icon="sparkle" onClose={() => actions.closeRebaseDialog()} dismissible={!applying} width="xwide" footer={footer}>
      {!plan ? <PreflightCard /> : null}
      {planLoading ? <p style={{ marginTop: 10 }}><Spinner /> Proposing a cleanup…</p> : null}
      {plan && alreadyTidy ? <Callout tone="info">This branch already looks tidy: every commit stays as-is, in order.</Callout> : null}
      {plan && !alreadyTidy ? (
        <>
          {plan.truncated ? <Callout tone="info">The commit range was larger than the input limit; some commits were sent to the model as headers/stats only or left out entirely (kept as pick).</Callout> : null}
          {plan.warnings.length ? (
            <Callout tone="warning">
              {plan.warnings.length} warning{plan.warnings.length === 1 ? '' : 's'}: {plan.warnings[0]}
              {plan.warnings.length > 1 ? ` (+${plan.warnings.length - 1} more)` : ''}
            </Callout>
          ) : null}
          {applying ? <ApplyProgressBar /> : null}
          <div className={showPreview ? 'rebase-board with-preview' : 'rebase-board'}>
            <div className="rebase-rows">
              {plan.rows.map((row, i) => (
                <RowEditor key={row.sha} row={row} index={i} plan={plan} />
              ))}
            </div>
            {showPreview ? <PreviewResult plan={plan} /> : null}
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
