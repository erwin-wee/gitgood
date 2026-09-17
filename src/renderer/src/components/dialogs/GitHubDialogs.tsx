import React, { useEffect, useState } from 'react';
import type { CheckRun, PullRequest } from '@shared/types';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Badge, Button, Callout, Checkbox, Dialog, Icon, RelativeTime, Spinner, TextField } from '../ui';

export function SignInDialog(): React.JSX.Element {
  const login = useAppStore((s) => s.login);
  const tools = useAppStore((s) => s.tools);
  const account = tools?.ghAccount ?? null;
  const ghMissing = tools ? !tools.gh.installed : false;
  useEffect(() => {
    if (account) closeDialog();
  }, [account]);
  return (
    <Dialog
      title="Sign in to GitHub"
      icon="github"
      onClose={() => {
        if (login.inProgress) void actions.cancelSignIn();
        closeDialog();
      }}
      footer={
        <>
          <Button onClick={() => { if (login.inProgress) void actions.cancelSignIn(); closeDialog(); }}>{login.inProgress ? 'Cancel' : 'Close'}</Button>
          {!login.inProgress ? (
            <Button variant="primary" icon="github" onClick={() => void actions.signIn('github.com')} disabled={ghMissing}>Sign in with your browser</Button>
          ) : null}
        </>
      }
    >
      {ghMissing ? (
        <Callout tone="warning">
          The GitHub CLI (gh) was not found. Install it from <Button variant="link" onClick={() => void actions.openExternal('https://cli.github.com')}>cli.github.com</Button> (on Windows: <span className="mono">winget install GitHub.cli</span>), then restart GitGood.
        </Callout>
      ) : null}
      <p>GitGood uses the GitHub CLI to sign you in with GitHub's OAuth device flow. Your token stays in the CLI's secure store and Git is configured to use it automatically for HTTPS pushes and pulls.</p>
      {login.inProgress ? (
        <>
          {login.code ? (
            <>
              <p>Enter this one-time code on GitHub:</p>
              <div className="device-code">{login.code}</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <Button icon="copy" onClick={() => void actions.copyToClipboard(login.code!, 'Code copied')}>Copy code</Button>
                <Button variant="primary" icon="external" onClick={() => void actions.openExternal(login.url ?? 'https://github.com/login/device')}>Open github.com/login/device</Button>
              </div>
              <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
                <Spinner /> Waiting for you to authorize in the browser…
              </p>
            </>
          ) : (
            <p>
              <Spinner /> Starting sign in…
            </p>
          )}
        </>
      ) : null}
      {login.error ? <Callout tone="danger">{login.error}</Callout> : null}
    </Dialog>
  );
}

export function ForcePushDialog(): React.JSX.Element {
  const status = useAppStore((s) => s.status);
  const [dontAsk, setDontAsk] = useState(false);
  const branch = status?.branch;
  return (
    <Dialog
      title="Force push?"
      icon="alert"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button onClick={() => { closeDialog(); void actions.pull(); }}>Fetch and pull first</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (dontAsk) void actions.updateSettings({ confirmForcePush: false });
              closeDialog();
              void actions.pushWithErrorHandling(true);
            }}
          >
            I'm sure, force push
          </Button>
        </>
      }
    >
      <p>
        Your branch <strong>{branch?.name}</strong> has diverged from its upstream: {branch?.ahead} local commit{branch?.ahead === 1 ? '' : 's'} and {branch?.behind} remote commit{branch?.behind === 1 ? '' : 's'} differ.
      </p>
      <Callout tone="warning">A force push (with lease) overwrites the remote branch with your local history. Remote commits that are not in your local branch will be lost for everyone.</Callout>
      <Checkbox checked={dontAsk} onChange={setDontAsk} label="Do not show this message again" />
    </Dialog>
  );
}

export function CreatePullRequestDialog(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const branches = useAppStore((s) => s.branches);
  const defaultBranch = useAppStore((s) => s.defaultBranch);
  const commits = useAppStore((s) => s.history.commits);
  const head = status?.branch.name ?? '';
  const [base, setBase] = useState(defaultBranch ?? 'main');
  const [title, setTitle] = useState(() => commits[0]?.summary ?? head.replace(/[-_/]+/g, ' '));
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ nameWithOwner: string; parent: string | null } | null>(null);
  useEffect(() => {
    if (!repo) return;
    void invoke('gh.pr.template', repo.path).then((t) => t && setBody(t)).catch(() => undefined);
    void invoke('gh.repo.view', repo.path).then((d) => d && setDetails({ nameWithOwner: d.nameWithOwner, parent: d.parent })).catch(() => undefined);
    if (commits.length === 1 && commits[0].body) setBody((b) => b || commits[0].body);
  }, [repo, commits]);
  const remoteBases = branches.filter((b) => b.kind === 'remote').map((b) => b.name.slice(b.name.indexOf('/') + 1)).filter((n) => n !== head);
  const bases = [...new Set([defaultBranch ?? 'main', ...remoteBases])];

  const create = async (web: boolean) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke('gh.pr.create', repo.path, { title: title.trim(), body, base, head, draft, web });
      closeDialog();
      if (result.url) actions.showToast({ kind: 'success', title: `Pull request created`, message: result.url, action: { label: 'Open', onClick: () => void actions.openExternal(result.url!) } }, 10000);
      void actions.loadCurrentPullRequest(true);
      void actions.loadPullRequests(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Create a pull request"
      icon="pull-request"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button icon="external" onClick={() => void create(true)} disabled={busy}>Create on GitHub.com</Button>
          <Button variant="primary" onClick={() => void create(false)} disabled={!title.trim() || busy} loading={busy}>{draft ? 'Create draft pull request' : 'Create pull request'}</Button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label>Base branch</label>
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {bases.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          {details?.parent ? <span className="hint">This repository is a fork of {details.parent}; the pull request targets your fork ({details.nameWithOwner}). Use “Create on GitHub.com” to target the upstream repository.</span> : null}
        </div>
        <div className="field">
          <label>Compare branch</label>
          <input value={head} readOnly />
        </div>
      </div>
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <div className="field">
        <label>Description</label>
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe your changes (Markdown supported)" />
      </div>
      <Checkbox checked={draft} onChange={setDraft} label="Create as draft" />
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

function bucketIcon(bucket: CheckRun['bucket']): { icon: 'check-circle' | 'x-circle' | 'clock' | 'skip'; color: string } {
  switch (bucket) {
    case 'pass':
      return { icon: 'check-circle', color: 'var(--success)' };
    case 'fail':
      return { icon: 'x-circle', color: 'var(--danger)' };
    case 'pending':
      return { icon: 'clock', color: 'var(--attention)' };
    default:
      return { icon: 'skip', color: 'var(--fg-muted)' };
  }
}

export function PullRequestDetailsDialog({ pr: initial }: { pr: PullRequest }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const [pr, setPr] = useState(initial);
  const [checks, setChecks] = useState<CheckRun[] | null>(null);
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('merge');
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!repo) return;
    try {
      const [fresh, ch] = await Promise.all([invoke('gh.pr.view', repo.path, pr.number), invoke('gh.pr.checks', repo.path, pr.number)]);
      setPr(fresh);
      setChecks(ch);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, initial.number]);

  const run = async (label: string, fn: () => Promise<void>, closeAfter = false) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      if (closeAfter) closeDialog();
      else await refresh();
      void actions.loadPullRequests(true);
      void actions.loadCurrentPullRequest(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!repo) return <></>;
  const stateTone = pr.state === 'MERGED' ? 'done' : pr.state === 'CLOSED' ? 'danger' : pr.isDraft ? 'neutral' : 'success';
  return (
    <Dialog
      title={
        <span>
          {pr.title} <span className="muted">#{pr.number}</span>
        </span>
      }
      icon="pull-request"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <span className="left">
            <Button variant="ghost" icon="external" onClick={() => void actions.openExternal(pr.url)}>Open on GitHub</Button>
          </span>
          <Button onClick={() => void run('checkout', () => actions.checkoutPullRequest(pr), true)} loading={busy === 'checkout'} icon="branch">Checkout</Button>
          {pr.state === 'OPEN' ? (
            <>
              <select value={method} onChange={(e) => setMethod(e.target.value as 'merge' | 'squash' | 'rebase')} style={{ padding: '4px 6px' }}>
                <option value="merge">Create a merge commit</option>
                <option value="squash">Squash and merge</option>
                <option value="rebase">Rebase and merge</option>
              </select>
              <Button variant="primary" loading={busy === 'merge'} disabled={pr.isDraft || pr.mergeable === 'CONFLICTING'} onClick={() => void run('merge', () => invoke('gh.pr.merge', repo.path, pr.number, method, deleteBranch))} title={pr.isDraft ? 'Mark the pull request as ready first' : pr.mergeable === 'CONFLICTING' ? 'Resolve conflicts first' : ''}>
                Merge pull request
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Badge tone={stateTone}>{pr.state === 'OPEN' && pr.isDraft ? 'Draft' : pr.state.toLowerCase()}</Badge>
        <span className="muted">
          {pr.author} wants to merge <span className="mono">{pr.headRepo && pr.isCrossRepository ? `${pr.headRepo}:` : ''}{pr.headRefName}</span> into <span className="mono">{pr.baseRefName}</span> · opened <RelativeTime date={pr.createdAt} />
        </span>
        {pr.additions !== null ? (
          <span>
            <span className="stat-add">+{pr.additions}</span> <span className="stat-del">−{pr.deletions}</span> <span className="muted">in {pr.changedFiles} files</span>
          </span>
        ) : null}
        {pr.reviewDecision ? <Badge tone={pr.reviewDecision === 'APPROVED' ? 'success' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'danger' : 'attention'}>{pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}</Badge> : null}
        {pr.mergeable === 'CONFLICTING' ? <Badge tone="danger">conflicts</Badge> : null}
        {pr.labels.map((l) => (
          <Badge key={l} outline>{l}</Badge>
        ))}
      </div>
      {pr.body ? <div className="markdown-preview callout" style={{ display: 'block' }}>{pr.body}</div> : null}
      <h4 style={{ margin: '12px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Checks {checks ? `(${pr.checks.passed}/${pr.checks.total} passed)` : ''}</h4>
      {checks === null ? (
        <Spinner />
      ) : checks.length === 0 ? (
        <p className="muted">No checks reported.</p>
      ) : (
        <div className="checks-list">
          {checks.map((c, i) => {
            const b = bucketIcon(c.bucket);
            return (
              <div key={i} className="check-row">
                <Icon name={b.icon} className="" />
                <span className="name" style={{ color: b.color === 'var(--fg-muted)' ? 'inherit' : undefined }}>
                  {c.workflow ? `${c.workflow} / ` : ''}
                  {c.name}
                </span>
                <span className="muted">{c.description || c.state.toLowerCase()}</span>
                {c.link ? <Button size="sm" variant="ghost" iconOnly icon="external" title="Open" onClick={() => void actions.openExternal(c.link)} /> : null}
              </div>
            );
          })}
        </div>
      )}
      {pr.state === 'OPEN' ? (
        <>
          <h4 style={{ margin: '12px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Review</h4>
          <textarea rows={3} placeholder="Leave a comment" value={comment} onChange={(e) => setComment(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" onClick={() => void run('comment', () => invoke('gh.pr.comment', repo.path, pr.number, comment).then(() => setComment('')))} disabled={!comment.trim()} loading={busy === 'comment'}>Comment</Button>
            <Button size="sm" variant="primary" onClick={() => void run('approve', () => invoke('gh.pr.review', repo.path, pr.number, 'approve', comment).then(() => setComment('')))} loading={busy === 'approve'}>Approve</Button>
            <Button size="sm" variant="danger" onClick={() => void run('changes', () => invoke('gh.pr.review', repo.path, pr.number, 'request-changes', comment).then(() => setComment('')))} disabled={!comment.trim()} loading={busy === 'changes'}>Request changes</Button>
            <span style={{ flex: 1 }} />
            {pr.isDraft ? <Button size="sm" onClick={() => void run('ready', () => invoke('gh.pr.ready', repo.path, pr.number, true))} loading={busy === 'ready'}>Ready for review</Button> : <Button size="sm" onClick={() => void run('draft', () => invoke('gh.pr.ready', repo.path, pr.number, false))} loading={busy === 'draft'}>Convert to draft</Button>}
            <Button size="sm" variant="danger" onClick={() => void run('close', () => invoke('gh.pr.close', repo.path, pr.number))} loading={busy === 'close'}>Close</Button>
          </div>
          <div style={{ marginTop: 8 }}>
            <Checkbox checked={deleteBranch} onChange={setDeleteBranch} label="Delete branch after merging" />
          </div>
        </>
      ) : pr.state === 'CLOSED' ? (
        <Button size="sm" onClick={() => void run('reopen', () => invoke('gh.pr.reopen', repo.path, pr.number))} loading={busy === 'reopen'}>Reopen</Button>
      ) : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}
