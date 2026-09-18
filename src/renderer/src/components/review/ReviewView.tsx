import React, { useMemo } from 'react';
import type { ReviewFinding, ReviewRun, ReviewSeverity } from '@shared/types';
import { isMac } from '../../api';
import * as actions from '../../state/actions';
import { useAppStore, type PrReviewRun } from '../../state/store';
import { CommitFileRow } from '../ChangesTab';
import { Badge, Button, Icon, PathLabel, Spinner, openContextMenu, type IconName } from '../ui';

export const SEVERITY_TONE: Record<ReviewSeverity, 'danger' | 'attention' | 'neutral'> = { blocker: 'danger', warning: 'attention', nit: 'neutral' };
export const SEVERITY_ICON: Record<ReviewSeverity, IconName> = { blocker: 'x-circle', warning: 'alert', nit: 'info' };
const VERDICT_LABEL = { approve: 'Approve', comment: 'Comment', 'request-changes': 'Request changes' } as const;
const VERDICT_TONE = { approve: 'success', comment: 'attention', 'request-changes': 'danger' } as const;

export function liveFindings(run: ReviewRun | null): ReviewFinding[] {
  return run ? run.findings.filter((f) => !f.dismissed) : [];
}

function targetLabel(run: PrReviewRun): React.ReactNode {
  if (run.target.kind === 'pr') {
    return (
      <>
        {run.target.title} <span className="muted">#{run.target.number}</span>
      </>
    );
  }
  return (
    <>
      <span className="mono">{run.target.head}</span> <span className="muted">against</span> <span className="mono">{run.target.base}</span>
    </>
  );
}

/** Replaces the main content area while a review is open: PR files, the diff pane slot and the findings panel. */
export function ReviewView(): React.JSX.Element {
  const review = useAppStore((s) => s.review);
  const run = review.run;
  const repo = useAppStore((s) => s.currentRepo);
  const findings = useMemo(() => liveFindings(run), [run]);
  const countByPath = useMemo(() => {
    const map = new Map<string, { n: number; worst: ReviewSeverity }>();
    for (const f of findings) {
      const cur = map.get(f.path);
      if (!cur) map.set(f.path, { n: 1, worst: f.severity });
      else map.set(f.path, { n: cur.n + 1, worst: rank(f.severity) < rank(cur.worst) ? f.severity : cur.worst });
    }
    return map;
  }, [findings]);

  if (!run) {
    return (
      <div className="empty-state">
        <Spinner large />
        <p>{review.progress?.message ?? 'Preparing the review…'}</p>
        <Button size="sm" onClick={() => void actions.cancelReview()}>Cancel</Button>
      </div>
    );
  }
  const reviewedFiles = run.files.filter((f) => f.status !== 'skipped' || countByPath.has(f.file.path));
  const skipped = run.files.filter((f) => f.status === 'skipped');
  return (
    <div className="review-view">
      <div className="review-files">
        <div className="changes-header">
          <Icon name="sparkle" />
          <span className="count truncate" title={run.target.kind === 'pr' ? run.target.title : undefined}>{targetLabel(run)}</span>
          <Button size="sm" variant="ghost" iconOnly icon="x" title="Close review" onClick={() => actions.closeReview()} />
        </div>
        <div className="file-list">
          {reviewedFiles.map((entry) => {
            const f = entry.file;
            const c = countByPath.get(f.path);
            return (
              <div key={f.path} className={`review-file-row ${entry.status}`}>
                <CommitFileRow
                  file={f}
                  selected={review.selectedPath === f.path}
                  onSelect={() => actions.selectReviewFile(f.path)}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { label: 'Open in external editor', onClick: () => void actions.openInEditor(f.path), disabled: f.status === 'deleted' },
                      { label: isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => void actions.showInFolder(f.status === 'deleted' ? null : f.path) },
                      { label: 'Copy relative file path', onClick: () => void actions.copyToClipboard(f.path, 'Path copied') },
                      { label: 'View on GitHub', onClick: () => repo?.github && void actions.openExternal(`${repo.github.url}/blob/${run.target.headSha}/${f.path}`), disabled: !repo?.github },
                    ])
                  }
                />
                {c ? <span className={`finding-count ${SEVERITY_TONE[c.worst]}`} title={`${c.n} finding${c.n === 1 ? '' : 's'}`}>{c.n}</span> : entry.status === 'failed' ? <span className="finding-count danger" title={entry.reason ?? 'failed'}>!</span> : entry.status === 'cancelled' ? <span className="finding-count neutral" title="not reviewed">–</span> : null}
              </div>
            );
          })}
          {skipped.length ? (
            <div className="review-skipped">
              <Icon name="skip" size={12} /> {skipped.length} file{skipped.length === 1 ? '' : 's'} skipped
              <ul>
                {skipped.map((s) => (
                  <li key={s.file.path} title={s.reason ?? ''}>
                    <PathLabel path={s.file.path} /> <span className="muted">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <div id="review-diff-slot" style={{ display: 'flex', flex: 1, minWidth: 0 }} />
      <ReviewPanel run={run} findings={findings} />
    </div>
  );
}

function rank(s: ReviewSeverity): number {
  return s === 'blocker' ? 0 : s === 'warning' ? 1 : 2;
}

function ReviewPanel({ run, findings }: { run: ReviewRun; findings: ReviewFinding[] }): React.JSX.Element {
  const review = useAppStore((s) => s.review);
  const stale = useAppStore((s) => {
    const r = s.review.run;
    if (!r) return false;
    if (r.target.kind === 'pr') {
      const number = r.target.number;
      const pr = s.prs.current?.number === number ? s.prs.current : s.prs.list.find((p) => p.number === number);
      return !!pr?.headSha && pr.headSha !== r.target.headSha;
    }
    return !!s.status?.branch.sha && s.status.branch.sha !== r.target.headSha;
  });
  const counts = { blocker: 0, warning: 0, nit: 0 } as Record<ReviewSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  const dismissed = run.findings.length - findings.length;
  const reviewed = run.files.filter((f) => f.status === 'reviewed').length;
  const failed = run.files.filter((f) => f.status === 'failed').length;
  const canPost = run.target.kind === 'pr' && !review.running;

  if (review.panelCollapsed) {
    return (
      <aside className="review-panel collapsed">
        <Button size="sm" variant="ghost" iconOnly icon="chevron-right" title="Show findings" onClick={() => actions.toggleReviewPanel()} />
        <Icon name="sparkle" />
        {counts.blocker ? <span className="collapsed-count danger" title={`${counts.blocker} blocker${counts.blocker === 1 ? '' : 's'}`}>{counts.blocker}</span> : null}
        {counts.warning ? <span className="collapsed-count attention" title={`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`}>{counts.warning}</span> : null}
        {counts.nit ? <span className="collapsed-count" title={`${counts.nit} nit${counts.nit === 1 ? '' : 's'}`}>{counts.nit}</span> : null}
        {review.running ? <Spinner /> : null}
      </aside>
    );
  }

  return (
    <aside className="review-panel">
      <div className="review-panel-header">
        <div className="review-panel-title">
          <Icon name="sparkle" />
          <strong>AI review</strong>
          {run.verdict ? <Badge tone={VERDICT_TONE[run.verdict]}>{VERDICT_LABEL[run.verdict]}</Badge> : null}
          {review.running ? <Spinner /> : null}
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" iconOnly icon="chevron-right" title="Hide findings panel" onClick={() => actions.toggleReviewPanel()} />
        </div>
        <div className="review-counts">
          {counts.blocker ? <span className="danger"><Icon name="x-circle" size={12} /> {counts.blocker}</span> : null}
          {counts.warning ? <span className="attention"><Icon name="alert" size={12} /> {counts.warning}</span> : null}
          {counts.nit ? <span className="neutral"><Icon name="info" size={12} /> {counts.nit}</span> : null}
          {!findings.length ? <span className="muted">No findings</span> : null}
          <span className="muted" style={{ marginLeft: 'auto' }}>{reviewed}/{run.files.filter((f) => f.status !== 'skipped').length} files · {run.model}</span>
        </div>
        {review.running && review.progress ? <div className="review-progress"><Spinner /> {review.progress.message}</div> : null}
        {stale ? (
          <div className="review-stale">
            <Icon name="alert" size={14} />
            <span>{run.target.kind === 'pr' ? 'The pull request was updated' : 'The branch has new commits'} since this review.</span>
            <Button size="sm" onClick={() => actions.rereview()} disabled={review.running}>Re-review changed files</Button>
          </div>
        ) : null}
        {run.error ? <div className="review-stale danger"><Icon name="x-circle" size={14} /><span>Review incomplete: {run.error}</span></div> : run.cancelled ? <div className="review-stale"><Icon name="info" size={14} /><span>Review cancelled before all files were checked.</span></div> : null}
        {run.summary ? <p className="review-summary selectable">{run.summary}</p> : null}
      </div>
      <div className="review-findings">
        {findings.map((f) => (
          <FindingRow key={f.id} finding={f} active={review.activeFindingId === f.id} />
        ))}
        {!findings.length && !review.running ? <div className="list-empty">{run.files.some((f) => f.status === 'reviewed') ? 'Nothing to flag in the reviewed files.' : 'No files were reviewed.'}</div> : null}
      </div>
      <div className="review-panel-footer">
        <span className="muted" style={{ fontSize: 11 }}>
          {run.droppedInvalid ? `${run.droppedInvalid} candidate${run.droppedInvalid === 1 ? '' : 's'} dropped by validation` : ''}
          {run.droppedInvalid && (dismissed || failed) ? ' · ' : ''}
          {dismissed ? `${dismissed} dismissed` : ''}
          {dismissed && failed ? ' · ' : ''}
          {failed ? `${failed} file${failed === 1 ? '' : 's'} failed` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" icon="sync" onClick={() => actions.rereview()} disabled={review.running} title="Run the review again; unchanged files keep their findings">Re-review</Button>
        {canPost ? <Button size="sm" variant="primary" icon="github" onClick={() => actions.openPostReview()}>Post review…</Button> : null}
      </div>
    </aside>
  );
}

function FindingRow({ finding, active }: { finding: ReviewFinding; active: boolean }): React.JSX.Element {
  return (
    <div className={`finding-row ${active ? 'active' : ''} ${finding.confidence === 'low' ? 'low-confidence' : ''}`} onClick={() => actions.focusFinding(finding)} title={finding.detail}>
      <Icon name={SEVERITY_ICON[finding.severity]} className={`finding-icon ${SEVERITY_TONE[finding.severity]}`} />
      <span className="finding-main">
        <span className="finding-title truncate">{finding.title}</span>
        <span className="finding-sub truncate">
          <span className="mono">{finding.path}:{finding.line}{finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : ''}</span> · {finding.category}
          {finding.confidence !== 'high' ? ` · ${finding.confidence} confidence` : ''}
        </span>
      </span>
      <Button size="sm" variant="ghost" iconOnly icon="x" title="Dismiss" onClick={(e) => { e.stopPropagation(); void actions.dismissFinding(finding); }} />
    </div>
  );
}

/** Inline card rendered under the annotated diff line. `onApply` is only supplied for pre-commit review findings on a whole-file (non-partial) selection with a suggestion; it writes the suggestion into the working tree. */
export function FindingCard({ finding, onApply }: { finding: ReviewFinding; onApply?: () => void }): React.JSX.Element {
  return (
    <div className={`finding-card ${SEVERITY_TONE[finding.severity]}`}>
      <div className="finding-card-header">
        <Icon name={SEVERITY_ICON[finding.severity]} className={`finding-icon ${SEVERITY_TONE[finding.severity]}`} />
        <strong className="selectable">{finding.title}</strong>
        <Badge tone={finding.severity === 'blocker' ? 'danger' : finding.severity === 'warning' ? 'attention' : 'neutral'}>{finding.severity}</Badge>
        <Badge outline>{finding.category}</Badge>
        {finding.confidence !== 'high' ? <Badge outline tone="neutral">{finding.confidence} confidence</Badge> : null}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" iconOnly icon="x" title="Dismiss finding" onClick={() => void actions.dismissFinding(finding)} />
      </div>
      <p className="selectable">{finding.detail}</p>
      {finding.suggestion !== null ? (
        <div className="finding-suggestion">
          <div className="finding-suggestion-header">
            <span className="muted">Suggested replacement for line{finding.endLine && finding.endLine !== finding.line ? `s ${finding.line}–${finding.endLine}` : ` ${finding.line}`}</span>
            <Button size="sm" variant="ghost" icon="copy" onClick={() => void actions.copyToClipboard(finding.suggestion ?? '', 'Suggestion copied')}>Copy</Button>
          </div>
          <pre className="selectable">{finding.suggestion}</pre>
        </div>
      ) : null}
      <div className="finding-card-actions">
        <Button size="sm" variant="ghost" icon="pencil" onClick={() => void actions.openInEditor(finding.path)}>Open in editor</Button>
        <Button size="sm" variant="ghost" icon="copy" onClick={() => void actions.copyToClipboard(`${finding.path}:${finding.line} ${finding.title}\n${finding.detail}`, 'Finding copied')}>Copy finding</Button>
        {onApply ? <Button size="sm" variant="primary" icon="check" onClick={onApply}>Apply to file</Button> : null}
      </div>
    </div>
  );
}
