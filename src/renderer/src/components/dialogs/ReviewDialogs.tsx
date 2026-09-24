import React, { useEffect, useMemo, useState } from 'react';
import type { ReviewFinding, ReviewSeverity, ReviewTarget } from '@shared/types';
import { errorMessage } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, useAppStore, type WorktreeReviewRun } from '../../state/store';
import { Badge, Button, Callout, Checkbox, Dialog, Icon, PathLabel, Spinner } from '../ui';
import { HelpPopover } from '../HelpPopover';
import { liveFindings, SEVERITY_TONE } from '../review/ReviewView';

/** Shared with the AI PR draft's first-use disclosure (see GitHubDialogs.tsx's CreatePullRequestDialog) so both AI features share one persisted "seen" flag. */
export const NOTICE_KEY = 'gitgood.review.noticeSeen';

function describeTarget(target: ReviewTarget): string {
  return target.kind === 'pr' ? `pull request #${target.number}` : `the current branch against ${target.base}`;
}

/** Pre-flight card: what will be sent, what is skipped, which model, then Start. */
export function ReviewPreflightDialog({ target }: { target: ReviewTarget }): React.JSX.Element {
  const review = useAppStore((s) => s.review);
  const plan = review.plan;
  const [showSkipped, setShowSkipped] = useState(false);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [noticeSeen, setNoticeSeen] = useState(() => {
    try {
      return localStorage.getItem(NOTICE_KEY) === '1';
    } catch {
      return true;
    }
  });
  useEffect(() => setDeselected(new Set()), [plan?.target.headSha]);

  const pending = plan?.files.filter((f) => f.status === 'pending') ?? [];
  const skipped = plan?.files.filter((f) => f.status === 'skipped') ?? [];
  const selected = pending.filter((f) => !deselected.has(f.file.path));
  const usePrevious = plan?.previousRun && plan.previousRun.headSha === plan.target.headSha ? plan.previousRun : null;
  const rereviewOf = plan?.previousRun && plan.previousRun.headSha !== plan.target.headSha ? plan.previousRun.id : undefined;

  const start = () => {
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      /* private mode */
    }
    void actions.startReview(target, { files: deselected.size ? selected.map((f) => f.file.path) : undefined, rereviewOf });
  };

  return (
    <Dialog
      title={<span className="dialog-title-with-help"><span>Review with AI</span><HelpPopover title="Review severity" explanation="Blocker means a critical issue, warning means a meaningful risk, and nit means a small improvement." note="Treat findings as a review aid: inspect the diff and fix or discuss issues before sharing the change." /></span>}
      icon="sparkle"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <span className="left">
            {plan ? <Button variant="ghost" icon="gear" onClick={() => openDialog({ kind: 'settings', tab: 'ai' })}>{plan.model} · {plan.effort} effort · {plan.strictness}</Button> : null}
          </span>
          <Button onClick={closeDialog}>Cancel</Button>
          {usePrevious ? <Button onClick={() => { closeDialog(); void actions.openExistingReview(target); }}>Show previous review</Button> : null}
          <Button variant="primary" icon="sparkle" onClick={start} disabled={!plan || !selected.length || review.running}>{rereviewOf ? 'Re-review changed files' : `Review ${selected.length} file${selected.length === 1 ? '' : 's'}`}</Button>
        </>
      }
    >
      <p>
        GitGood will send the diff of {describeTarget(target)} to the configured AI provider and show findings as inline annotations. Nothing is posted to GitHub until you choose to.
      </p>
      {!noticeSeen ? (
        <Callout tone="info">
          The diff, pull request description and up to 400 lines of surrounding code per file are sent to {plan?.provider === 'claude-cli' ? 'Claude Code' : 'the Anthropic API'}. Do not review changes you are not allowed to share with that service.
          <div style={{ marginTop: 6 }}>
            <Button size="sm" onClick={() => setNoticeSeen(true)}>Got it</Button>
          </div>
        </Callout>
      ) : null}
      {review.planLoading ? (
        <p>
          <Spinner /> Reading the diff…
        </p>
      ) : review.planError ? (
        <Callout tone="danger">
          {review.planError}
          <div style={{ marginTop: 6 }}>
            <Button size="sm" onClick={() => void actions.loadReviewPlan(target)}>Retry</Button>
          </div>
        </Callout>
      ) : plan ? (
        <>
          <div className="review-plan-summary">
            <span><strong>{pending.length}</strong> file{pending.length === 1 ? '' : 's'} to review</span>
            <span><strong>{plan.changedLines.toLocaleString()}</strong> changed lines</span>
            {skipped.length ? <Button variant="link" onClick={() => setShowSkipped((v) => !v)}>{skipped.length} skipped {showSkipped ? '▴' : '▾'}</Button> : null}
            {plan.ownPullRequest ? <Badge tone="attention" title="GitHub only allows comment reviews on your own pull request">your pull request</Badge> : null}
            {plan.target.kind === 'branch' ? <Badge outline>local branch mode</Badge> : null}
          </div>
          {pending.length > plan.maxFiles ? <Callout tone="warning">Only the first {plan.maxFiles} reviewable files are included (Options → AI → Review file limit).</Callout> : null}
          {rereviewOf ? <Callout tone="info">A previous review exists for an older commit. Files whose diff did not change will keep their findings.</Callout> : null}
          <div className="review-plan-files">
            {pending.map((entry) => (
              <label key={entry.file.path} className="review-plan-file">
                <Checkbox checked={!deselected.has(entry.file.path)} onChange={(v) => setDeselected((d) => { const n = new Set(d); if (v) n.delete(entry.file.path); else n.add(entry.file.path); return n; })} />
                <PathLabel path={entry.file.path} />
                <span className="stats">
                  {entry.file.additions ? <span className="stat-add">+{entry.file.additions}</span> : null} {entry.file.deletions ? <span className="stat-del">−{entry.file.deletions}</span> : null}
                </span>
              </label>
            ))}
            {!pending.length ? <div className="list-empty">Nothing to review: every changed file is binary, generated or empty.</div> : null}
          </div>
          {showSkipped && skipped.length ? (
            <div className="review-plan-files skipped">
              {skipped.map((entry) => (
                <div key={entry.file.path} className="review-plan-file">
                  <Icon name="skip" size={12} className="muted" />
                  <PathLabel path={entry.file.path} />
                  <span className="muted">{entry.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}

const EVENT_LABEL = { APPROVE: 'Approve', COMMENT: 'Comment', REQUEST_CHANGES: 'Request changes' } as const;
type ReviewEvent = keyof typeof EVENT_LABEL;

function defaultEvent(verdict: string | null, own: boolean): ReviewEvent {
  if (own) return 'COMMENT';
  return verdict === 'approve' ? 'APPROVE' : verdict === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT';
}

/** Confirmation before creating the GitHub review: verdict, body, which findings become inline comments. */
export function PostReviewDialog(): React.JSX.Element {
  const run = useAppStore((s) => s.review.run);
  const settings = useAppStore((s) => s.settings);
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  const findings = useMemo(() => liveFindings(run), [run]);
  const [event, setEvent] = useState<ReviewEvent>(() => defaultEvent(run?.verdict ?? null, run?.ownPullRequest ?? false));
  const [body, setBody] = useState(run?.summary ?? '');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(findings.filter((f) => f.severity !== 'nit').map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!run || run.target.kind !== 'pr') return <></>;
  const number = run.target.number;
  const toggle = (f: ReviewFinding, on: boolean) => setChosen((c) => { const n = new Set(c); if (on) n.add(f.id); else n.delete(f.id); return n; });
  const bySeverity = (s: ReviewSeverity) => findings.filter((f) => f.severity === s);

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await actions.postReview({ runId: run.id, event, body, findingIds: [...chosen] });
      closeDialog();
      void actions.loadPullRequests(true);
      void actions.loadCurrentPullRequest(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Post review to pull request #${number}`}
      icon="github"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant={event === 'REQUEST_CHANGES' ? 'danger' : 'primary'} icon="github" loading={busy} disabled={busy || (!body.trim() && !chosen.size && event !== 'APPROVE')} onClick={() => void post()}>
            {EVENT_LABEL[event]} with {chosen.size} inline comment{chosen.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {run.ownPullRequest ? <Callout tone="info">This is your own pull request, so GitHub only accepts a comment review.</Callout> : null}
      <div className="form-grid">
        <div className="field">
          <label>Verdict</label>
          <select value={event} onChange={(e) => setEvent(e.target.value as ReviewEvent)}>
            <option value="COMMENT">Comment</option>
            <option value="APPROVE" disabled={run.ownPullRequest}>Approve</option>
            <option value="REQUEST_CHANGES" disabled={run.ownPullRequest}>Request changes</option>
          </select>
          {run.verdict ? <span className="hint">The AI suggested: {run.verdict.replace('-', ' ')}. You decide.</span> : null}
        </div>
        <div className="field">
          <label>Commit</label>
          <input readOnly value={run.target.headSha.slice(0, 12)} className="mono" />
          <span className="hint">Comments are anchored to this commit; posting is refused if the PR moved.</span>
        </div>
      </div>
      <div className="field">
        <label>Review body</label>
        <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Summary of the review (Markdown supported)" />
        {settings?.ai.reviewPostFooter ? <span className="hint">A footer will be appended: “Drafted with AI in GitGood; reviewed by @{account?.login ?? 'you'}”. Turn it off under Options → AI.</span> : null}
      </div>
      <div className="field">
        <label>Inline comments ({chosen.size} of {findings.length})</label>
        <div className="review-post-findings">
          {(['blocker', 'warning', 'nit'] as ReviewSeverity[]).map((sev) =>
            bySeverity(sev).map((f) => (
              <label key={f.id} className="review-post-finding">
                <Checkbox checked={chosen.has(f.id)} onChange={(v) => toggle(f, v)} />
                <Badge tone={SEVERITY_TONE[f.severity] === 'danger' ? 'danger' : SEVERITY_TONE[f.severity] === 'attention' ? 'attention' : 'neutral'}>{f.severity}</Badge>
                <span className="truncate" title={f.detail}>{f.title}</span>
                <span className="mono muted">{f.path}:{f.line}</span>
              </label>
            )),
          )}
          {!findings.length ? <div className="list-empty">No findings to post; the review will contain only the body.</div> : null}
        </div>
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pre-commit review gate ("Review before every commit")
// ---------------------------------------------------------------------------

/** Shown when the "Review before every commit" setting is on and the review found something; Go back leaves the working tree, index and form untouched. */
export function PrecommitReviewGateDialog({ run, onCommitAnyway }: { run: WorktreeReviewRun; onCommitAnyway: () => void }): React.JSX.Element {
  const findings = useMemo(() => liveFindings(run), [run]);
  const counts = { blocker: 0, warning: 0, nit: 0 } as Record<ReviewSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  return (
    <Dialog
      title="AI review found something"
      icon="sparkle"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button onClick={closeDialog}>Go back</Button>
          <Button variant={counts.blocker ? 'danger' : 'primary'} icon="commit" onClick={onCommitAnyway}>Commit anyway</Button>
        </>
      }
    >
      {run.commitMessageMatches === false ? <Callout tone="warning">{run.commitMessageNote || 'The typed commit message may not match the diff.'}</Callout> : null}
      {run.summary ? <p className="selectable">{run.summary}</p> : null}
      {counts.blocker ? <Callout tone="warning">Blocker findings indicate critical issues. Committing now may ship them; go back and fix them first.</Callout> : null}
      <div className="review-post-findings">
        {(['blocker', 'warning', 'nit'] as ReviewSeverity[]).map((sev) =>
          findings
            .filter((f) => f.severity === sev)
            .map((f) => (
              <div key={f.id} className="review-post-finding">
                <Badge tone={SEVERITY_TONE[f.severity] === 'danger' ? 'danger' : SEVERITY_TONE[f.severity] === 'attention' ? 'attention' : 'neutral'}>{f.severity}</Badge>
                <span className="truncate" title={f.detail}>{f.title}</span>
                <span className="mono muted">{f.path}:{f.line}</span>
              </div>
            )),
        )}
        {!findings.length ? <div className="list-empty">No findings survived validation.</div> : null}
      </div>
      {run.droppedInvalid ? <p className="muted" style={{ fontSize: 12 }}>{run.droppedInvalid} candidate{run.droppedInvalid === 1 ? '' : 's'} dropped by validation.</p> : null}
    </Dialog>
  );
}
