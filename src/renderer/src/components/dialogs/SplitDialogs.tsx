import React, { useEffect, useState } from 'react';
import type { FileDiff, SplitPlan, SplitPlanCommit } from '@shared/types';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { useAppStore } from '../../state/store';
import { Badge, Button, Callout, Dialog, Icon, PathLabel, Spinner } from '../ui';
import { TextDiff } from '../diff/TextDiff';

const DND_HUNK = 'application/x-gitgood-split-hunk';
const DND_FILE = 'application/x-gitgood-split-file';
const DND_COMMIT = 'application/x-gitgood-split-commit';
const NOT_INCLUDED = 'unassigned';

function formatBytesShort(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Read-only diff preview for the selected hunk
// ---------------------------------------------------------------------------

function SplitHunkPreview({ path, hunkIndex }: { path: string; hunkIndex: number }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    if (!repo) return;
    void invoke('repo.diff.working', repo.path, path, { hideWhitespace: false })
      .then((d) => !cancelled && setDiff(d))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [repo, path]);

  if (error) return <Callout tone="danger">{error}</Callout>;
  if (!diff) return <p><Spinner /> Loading preview…</p>;
  if (diff.kind !== 'text' || !diff.hunks[hunkIndex]) return <p className="muted">This hunk's preview is no longer available; the file may have changed.</p>;

  const single = { ...diff, hunks: [diff.hunks[hunkIndex]] };
  return (
    <div className="split-preview-diff">
      <TextDiff diff={single} mode="unified" wrap syntax intraline={false} selectable={false} selectedLines={null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pre-flight card (before any AI call)
// ---------------------------------------------------------------------------

function PreflightCard(): React.JSX.Element {
  const split = useAppStore((s) => s.split);
  const { preflight, preflightLoading, preflightError } = split;

  if (preflightLoading) return <p><Spinner /> Reading changes…</p>;
  if (preflightError) {
    return (
      <Callout tone="danger">
        {preflightError}
        <div style={{ marginTop: 6 }}>
          <Button size="sm" onClick={() => void actions.loadSplitPreflight()}>Retry</Button>
        </div>
      </Callout>
    );
  }
  if (!preflight) return <></>;

  const canPropose = preflight.hunkCount + preflight.wholeFileOnly.length >= 2;

  return (
    <>
      <p>GitGood will send the included changes to the configured AI provider and propose grouping them into an ordered set of commits. Nothing is staged or committed until you click Apply.</p>
      <div className="review-plan-summary">
        <span><strong>{preflight.fileCount}</strong> file{preflight.fileCount === 1 ? '' : 's'}</span>
        <span><strong>{preflight.hunkCount}</strong> hunk{preflight.hunkCount === 1 ? '' : 's'}</span>
        <span className="muted">~{formatBytesShort(preflight.estimatedBytes)}</span>
        {preflight.oversized ? <Badge tone="attention">large change</Badge> : null}
      </div>
      {!canPropose ? <Callout tone="info">At least two hunks or whole files are needed to split into commits.</Callout> : null}
      {preflight.oversized ? (
        <Callout tone="info">
          This change is large ({formatBytesShort(preflight.estimatedBytes)}); sending full line content would be slow and expensive. GitGood can send only hunk headers and line-count stats instead — the model groups by file and context, without seeing the actual code.
        </Callout>
      ) : null}
      {preflight.wholeFileOnly.length ? (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Whole-file only (cannot be split into hunks):</p>
          <div className="review-plan-files skipped">
            {preflight.wholeFileOnly.map((f) => (
              <div key={f.path} className="review-plan-file">
                <PathLabel path={f.path} />
                <span className="muted">{f.reason}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {preflight.excluded.length ? (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Excluded (cannot be committed as part of a split):</p>
          <div className="review-plan-files skipped">
            {preflight.excluded.map((f) => (
              <div key={f.path} className="review-plan-file">
                <Icon name="skip" size={12} className="muted" />
                <PathLabel path={f.path} />
                <span className="muted">{f.reason}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Editable plan board: commit cards + Not included bucket
// ---------------------------------------------------------------------------

function HunkRow({ id, label, path, additions, deletions, active, onSelect }: { id: string; label: string; path: string; additions: number; deletions: number; active: boolean; onSelect: () => void }): React.JSX.Element {
  return (
    <div className={`split-item ${active ? 'active' : ''}`} draggable onDragStart={(e) => e.dataTransfer.setData(DND_HUNK, id)} onClick={onSelect} title={label}>
      <Icon name="kebab" size={10} className="muted split-drag-handle" />
      <PathLabel path={path} />
      <span className="stats">
        {additions ? <span className="stat-add">+{additions}</span> : null}
        {deletions ? <span className="stat-del">−{deletions}</span> : null}
      </span>
    </div>
  );
}

function WholeFileRow({ path, reason }: { path: string; reason?: string }): React.JSX.Element {
  return (
    <div className="split-item" draggable onDragStart={(e) => e.dataTransfer.setData(DND_FILE, path)} title={reason}>
      <Icon name="kebab" size={10} className="muted split-drag-handle" />
      <PathLabel path={path} />
      <Badge outline>whole file</Badge>
    </div>
  );
}

function acceptsDrop(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DND_HUNK) || e.dataTransfer.types.includes(DND_FILE) || e.dataTransfer.types.includes(DND_COMMIT);
}

function CommitCard({ commit, index, total, plan, selectedHunkId }: { commit: SplitPlanCommit; index: number; total: number; plan: SplitPlan; selectedHunkId: string | null }): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const isPlaceholder = !commit.summary.trim();

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const hunkId = e.dataTransfer.getData(DND_HUNK);
    const path = e.dataTransfer.getData(DND_FILE);
    const commitId = e.dataTransfer.getData(DND_COMMIT);
    if (hunkId) actions.moveHunkTo(hunkId, commit.id);
    else if (path) actions.moveWholeFileTo(path, commit.id);
    else if (commitId && commitId !== commit.id) actions.reorderCommit(plan.commits.findIndex((c) => c.id === commitId), index);
  };

  return (
    <div
      className={`split-commit-card ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => acceptsDrop(e) && (e.preventDefault(), setDragOver(true))}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}
    >
      <div className="split-commit-header" draggable onDragStart={(e) => e.dataTransfer.setData(DND_COMMIT, commit.id)}>
        <Icon name="kebab" size={12} className="muted split-drag-handle" title="Drag to reorder" />
        <Badge outline>{index + 1}</Badge>
        {editing ? (
          <input autoFocus className="split-summary-input" value={commit.summary} onChange={(e) => actions.updateCommitMessage(commit.id, { summary: e.target.value })} onBlur={() => setEditing(false)} placeholder="Commit summary" />
        ) : (
          <button type="button" className="split-summary-display" onClick={() => setEditing(true)} title="Click to edit">
            {commit.summary || 'Click to add a summary…'}
          </button>
        )}
        {isPlaceholder ? <Icon name="alert" size={12} className="attention" title="This commit needs a summary before it can be applied" /> : null}
        <span style={{ flex: 1 }} />
        {index > 0 ? <Button size="sm" variant="ghost" icon="merge" title="Merge into the previous commit" onClick={() => actions.mergeCommitInto(commit.id, plan.commits[index - 1].id)} /> : null}
        <Button size="sm" variant="ghost" icon="trash" title="Delete this commit (its changes move to Not included)" onClick={() => actions.deleteCommit(commit.id)} />
      </div>
      <textarea
        className="split-description-input"
        placeholder="Description (optional)"
        value={commit.description}
        onChange={(e) => actions.updateCommitMessage(commit.id, { description: e.target.value })}
        rows={2}
      />
      {commit.rationale ? <p className="muted split-rationale">{commit.rationale}</p> : null}
      <div className="split-item-list">
        {commit.hunkIds.map((id) => {
          const h = plan.hunks.find((x) => x.id === id);
          if (!h) return null;
          return <HunkRow key={id} id={id} label={h.header} path={h.path} additions={h.additions} deletions={h.deletions} active={selectedHunkId === id} onSelect={() => actions.selectSplitHunk(id)} />;
        })}
        {commit.wholeFiles.map((path) => (
          <WholeFileRow key={path} path={path} />
        ))}
        {!commit.hunkIds.length && !commit.wholeFiles.length ? <div className="list-empty">Drag hunks here.</div> : null}
      </div>
      <div className="split-card-footer muted">
        {commit.hunkIds.length + commit.wholeFiles.length} change{commit.hunkIds.length + commit.wholeFiles.length === 1 ? '' : 's'}
        {total > 1 ? ` · commit ${index + 1} of ${total}` : ''}
      </div>
    </div>
  );
}

function NotIncludedBucket({ plan, selectedHunkId }: { plan: SplitPlan; selectedHunkId: string | null }): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false);
  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const hunkId = e.dataTransfer.getData(DND_HUNK);
    const path = e.dataTransfer.getData(DND_FILE);
    if (hunkId) actions.moveHunkTo(hunkId, NOT_INCLUDED);
    else if (path) actions.moveWholeFileTo(path, NOT_INCLUDED);
  };
  const hunkIds = plan.unassigned.filter((id) => plan.hunks.some((h) => h.id === id));
  const paths = plan.unassigned.filter((id) => !plan.hunks.some((h) => h.id === id));
  return (
    <div
      className={`split-commit-card split-unassigned ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => acceptsDrop(e) && (e.preventDefault(), setDragOver(true))}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}
    >
      <div className="split-commit-header">
        <Icon name="skip" size={12} className="muted" />
        <strong>Not included</strong>
        <span className="muted" style={{ fontSize: 11 }}>never committed silently</span>
      </div>
      <div className="split-item-list">
        {hunkIds.map((id) => {
          const h = plan.hunks.find((x) => x.id === id)!;
          return <HunkRow key={id} id={id} label={h.header} path={h.path} additions={h.additions} deletions={h.deletions} active={selectedHunkId === id} onSelect={() => actions.selectSplitHunk(id)} />;
        })}
        {paths.map((path) => (
          <WholeFileRow key={path} path={path} />
        ))}
        {!hunkIds.length && !paths.length ? <div className="list-empty">Nothing left out.</div> : null}
      </div>
    </div>
  );
}

function ApplyProgressBar(): React.JSX.Element {
  const split = useAppStore((s) => s.split);
  const p = split.applyProgress;
  return (
    <div className="split-apply-progress">
      <Spinner />
      <span>{p?.message ?? 'Applying…'}</span>
      {p ? (
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {Math.min(p.index + 1, p.total)} of {p.total}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export function SplitPlanDialog(): React.JSX.Element {
  const split = useAppStore((s) => s.split);
  const { preflight, plan, planLoading, planError, applying, applyError, fileOnly } = split;

  const selectedHunk = split.selectedHunkId ? plan?.hunks.find((h) => h.id === split.selectedHunkId) ?? null : null;
  const alreadyCoherent = actions.splitAlreadyCoherent(plan);
  const canApply = actions.canApplySplit(plan);
  const commitCount = plan?.commits.length ?? 0;

  const footer = (
    <>
      <span className="left">
        {planError || applyError ? <Callout tone="danger" icon="alert">{applyError?.message ?? planError}</Callout> : null}
      </span>
      {!applying ? <Button onClick={() => actions.closeSplitDialog()}>Cancel</Button> : null}
      {plan && !alreadyCoherent ? (
        <Button variant="ghost" onClick={() => actions.reproposeSplit()} disabled={applying}>
          Re-propose
        </Button>
      ) : null}
      {!plan && !planLoading && preflight ? (
        <>
          {preflight.oversized ? <Button onClick={() => void actions.proposeSplit(true)}>Split by file only</Button> : null}
          <Button variant="primary" icon="sparkle" onClick={() => void actions.proposeSplit(false)} disabled={preflight.hunkCount + preflight.wholeFileOnly.length < 2}>
            Propose
          </Button>
        </>
      ) : null}
      {planLoading ? (
        <Button variant="ghost" onClick={() => actions.cancelSplitPropose()}>
          Cancel proposing
        </Button>
      ) : null}
      {plan && !alreadyCoherent ? (
        <Button variant="primary" icon="commit" loading={applying} disabled={!canApply || applying} onClick={() => void actions.applySplit()}>
          Apply {commitCount} commit{commitCount === 1 ? '' : 's'}
        </Button>
      ) : null}
    </>
  );

  return (
    <Dialog title="Split into commits with AI" icon="sparkle" onClose={() => actions.closeSplitDialog()} dismissible={!applying} width="xwide" footer={footer}>
      {!plan ? <PreflightCard /> : null}
      {planLoading ? (
        <p style={{ marginTop: 10 }}>
          <Spinner /> Proposing a split{fileOnly ? ' (file-only)' : ''}…
        </p>
      ) : null}
      {plan && alreadyCoherent ? (
        <Callout tone="info">
          This change is already coherent: the model put everything in one commit. Close this dialog and use the normal commit form.
        </Callout>
      ) : null}
      {plan && !alreadyCoherent ? (
        <>
          {plan.warnings.length ? (
            <Callout tone="warning">
              {plan.warnings.length} warning{plan.warnings.length === 1 ? '' : 's'}: {plan.warnings[0]}
              {plan.warnings.length > 1 ? ` (+${plan.warnings.length - 1} more)` : ''}
            </Callout>
          ) : null}
          {applying ? <ApplyProgressBar /> : null}
          <div className="split-board">
            {plan.commits.map((commit, i) => (
              <CommitCard key={commit.id} commit={commit} index={i} total={plan.commits.length} plan={plan} selectedHunkId={split.selectedHunkId} />
            ))}
            <NotIncludedBucket plan={plan} selectedHunkId={split.selectedHunkId} />
          </div>
          <div className="split-preview">
            {selectedHunk ? (
              <>
                <div className="split-preview-header">
                  <PathLabel path={selectedHunk.path} />
                  <span className="muted mono">{selectedHunk.header}</span>
                </div>
                <SplitHunkPreview path={selectedHunk.path} hunkIndex={selectedHunk.hunkIndex} />
              </>
            ) : (
              <div className="list-empty">Select a hunk to preview its diff.</div>
            )}
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
