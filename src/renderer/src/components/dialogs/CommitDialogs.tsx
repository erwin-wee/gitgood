import React, { useEffect, useState } from 'react';
import type { Commit, ErrorFix, GitErrorInfo } from '@shared/types';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, useAppStore } from '../../state/store';
import { Button, Callout, Checkbox, Dialog, Spinner, TextField } from '../ui';

/** Codes with their own dedicated recovery flow elsewhere; the "Explain with AI" row never shows for them. */
const DEDICATED_FLOW_CODES = new Set<GitErrorInfo['code']>(['conflicts', 'gh-not-authenticated', 'ai-not-configured', 'cancelled']);

const RISK_LABEL: Record<string, string> = { safe: 'Safe', 'changes-history': 'Rewrites history', 'discards-work': 'Discards work', 'touches-remote': 'Touches the remote' };

function looksOffline(message: string): boolean {
  return /network|offline|could not reach|connection|ENOTFOUND|ECONNREFUSED/i.test(message);
}

/** One suggested fix inside the error dialog's "Explain with AI" section. */
function ErrorFixRow({ fix, retry }: { fix: ErrorFix; retry?: () => void }): React.JSX.Element {
  const repoPath = useAppStore((s) => s.currentRepo?.path ?? null);
  return (
    <div className="file-preview-list" style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <strong style={{ fontSize: 12 }}>{fix.label}</strong>
        <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{RISK_LABEL[fix.risk] ?? fix.risk}</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>{fix.detail}</p>
      {fix.action ? (
        <Button size="sm" onClick={() => void actions.applyErrorFix(fix, retry)}>{fix.label}</Button>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="mono selectable" style={{ fontSize: 12 }}>{fix.command}</span>
          <Button size="sm" variant="ghost" icon="copy" onClick={() => void actions.copyToClipboard(fix.command ?? '', 'Command copied')}>Copy</Button>
          <Button size="sm" variant="ghost" icon="terminal" onClick={() => void actions.openInShellAt(repoPath ?? '')}>Run in terminal</Button>
        </div>
      )}
    </div>
  );
}

/** The collapsible "Explain with AI" section inside ErrorDialog. */
function ErrorExplainSection({ info, retryable, retry }: { info: GitErrorInfo; retryable: boolean; retry?: () => void }): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings);
  const explain = useAppStore((s) => s.errorExplain);
  const eligible = settings?.ai.provider !== 'disabled' && !DEDICATED_FLOW_CODES.has(info.code);
  const automatic = eligible && settings?.ai.explainErrorsAutomatically === true && info.code === 'unknown';
  const [expanded, setExpanded] = useState(automatic);

  useEffect(() => {
    if (!eligible) return;
    actions.resetErrorExplanation();
    if (automatic) void actions.requestErrorExplanation(info, retryable);
    // Only ever runs once per mount (a fresh error dialog instance): automatic mode must never retry on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!eligible) return null;

  const load = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !explain.result && !explain.loading && !explain.error) void actions.requestErrorExplanation(info, retryable);
  };

  return (
    <div className="error-explain" style={{ marginTop: 8 }}>
      <Button variant="ghost" size="sm" icon="sparkle" onClick={load}>{expanded ? 'Hide AI explanation' : 'Explain with AI'}</Button>
      {expanded ? (
        <div style={{ marginTop: 8 }}>
          {explain.loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner /> <span className="muted" style={{ fontSize: 12 }}>Asking AI what happened…</span>
              <Button size="sm" variant="ghost" onClick={() => actions.cancelErrorExplanation()}>Cancel</Button>
            </div>
          ) : explain.error ? (
            <Callout tone="warning">
              {looksOffline(explain.error) ? 'GitGood appears to be offline.' : `Could not get an explanation: ${explain.error}`}
              <div style={{ marginTop: 6 }}>
                <Button size="sm" onClick={() => void actions.requestErrorExplanation(info, retryable)}>Retry</Button>
              </div>
            </Callout>
          ) : explain.result ? (
            <>
              <p className="selectable" style={{ marginTop: 0 }}>{explain.result.whatHappened}</p>
              {explain.result.likelyCause ? <p className="muted selectable" style={{ fontSize: 12 }}>{explain.result.likelyCause}</p> : null}
              {explain.result.fixes.map((fix, i) => (
                <ErrorFixRow key={i} fix={fix} retry={retry} />
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                {explain.feedbackGiven ? (
                  <span className="muted" style={{ fontSize: 11 }}>Thanks for the feedback.</span>
                ) : (
                  <>
                    <span className="muted" style={{ fontSize: 11 }}>Was this helpful?</span>
                    <Button size="sm" variant="ghost" onClick={() => actions.recordErrorExplanationFeedback(true)}>Yes</Button>
                    <Button size="sm" variant="ghost" onClick={() => actions.recordErrorExplanationFeedback(false)}>No</Button>
                  </>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DiscardDialog({ paths, all }: { paths: string[]; all: boolean }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const [dontAsk, setDontAsk] = useState(false);
  const trash = settings?.confirmDiscardChangesPermanently !== false;
  const platform = window.gitgoodBridge.platform;
  const binName = platform === 'win32' ? 'Recycle Bin' : 'Trash';
  return (
    <Dialog
      title={all ? 'Discard all changes?' : paths.length === 1 ? 'Discard changes?' : `Discard ${paths.length} changes?`}
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (dontAsk) void actions.updateSettings({ confirmDiscardChanges: false });
              void actions.discard(paths, all);
            }}
          >
            {all ? 'Discard all changes' : paths.length === 1 ? 'Discard changes' : `Discard ${paths.length} changes`}
          </Button>
        </>
      }
    >
      <p>{all ? 'Are you sure you want to discard all changes in this repository?' : paths.length === 1 ? <>Are you sure you want to discard all changes to <strong>{paths[0]}</strong>?</> : 'Are you sure you want to discard changes to the following files?'}</p>
      {!all && paths.length > 1 ? (
        <div className="file-preview-list">
          {paths.slice(0, 20).map((p) => (
            <div key={p}>{p}</div>
          ))}
          {paths.length > 20 ? <div className="muted">…and {paths.length - 20} more</div> : null}
        </div>
      ) : null}
      <p className="muted" style={{ fontSize: 12 }}>{trash ? `Changed files are moved to the ${binName} so you can recover them if needed.` : 'Changes are discarded permanently.'}</p>
      <Checkbox checked={dontAsk} onChange={setDontAsk} label="Do not show this message again" />
    </Dialog>
  );
}

export function DiscardLinesDialog({ path, patch, count }: { path: string; patch: string; count: number }): React.JSX.Element {
  return (
    <Dialog
      title="Discard selected lines?"
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" onClick={() => void actions.discardPatch(patch)}>Discard {count} line{count === 1 ? '' : 's'}</Button>
        </>
      }
    >
      <p>
        Are you sure you want to discard the {count} selected line{count === 1 ? '' : 's'} in <strong>{path}</strong>? This cannot be undone.
      </p>
    </Dialog>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, checkbox }: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; checkbox?: { label: string; onChange: (v: boolean) => void } }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  return (
    <Dialog
      title={title}
      icon={danger ? 'alert' : 'info'}
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                closeDialog();
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
      {checkbox ? <Checkbox checked={checked} onChange={(v) => { setChecked(v); checkbox.onChange(v); }} label={checkbox.label} /> : null}
    </Dialog>
  );
}

export function ErrorDialog({ title, error, retry }: { title: string; error: GitErrorInfo | string; retry?: () => void }): React.JSX.Element {
  const info: GitErrorInfo | null = typeof error === 'string' ? null : error;
  const message = typeof error === 'string' ? error : error.message;
  const [showDetails, setShowDetails] = useState(false);
  const details = info ? [info.command ? `$ ${info.command}` : '', info.exitCode !== null ? `exit code ${info.exitCode}` : '', info.stderr, info.stdout].filter(Boolean).join('\n') : '';
  const hint = info?.code === 'auth-failed' ? 'Sign in to GitHub from Options → Accounts, or check that your credentials are valid for this remote.' : info?.code === 'network' ? 'Check your network connection and that the remote URL is reachable.' : info?.code === 'lock-file' ? 'Another Git process may be running. If not, delete the .git/index.lock file and try again.' : info?.code === 'tool-missing' ? 'Install the missing tool or set its location in Options → Advanced.' : info?.code === 'protected-branch' ? 'The remote rejected this push because of branch protection rules. Open a pull request instead.' : null;
  return (
    <Dialog
      title={title}
      icon="alert"
      onClose={closeDialog}
      footer={
        <>
          {details ? (
            <span className="left">
              <Button variant="ghost" size="sm" onClick={() => setShowDetails((v) => !v)}>{showDetails ? 'Hide details' : 'Show details'}</Button>
              <Button variant="ghost" size="sm" icon="copy" onClick={() => void actions.copyToClipboard(`${message}\n\n${details}`, 'Error details copied')}>Copy</Button>
            </span>
          ) : null}
          {retry ? <Button onClick={() => { closeDialog(); retry(); }}>Retry</Button> : null}
          <Button variant="primary" onClick={closeDialog}>Close</Button>
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} className="selectable">{message}</p>
      {hint ? <Callout tone="info">{hint}</Callout> : null}
      {showDetails && details ? <pre className="details-block">{details}</pre> : null}
      {info ? <ErrorExplainSection info={info} retryable={!!retry} retry={retry} /> : null}
    </Dialog>
  );
}

export function SigningFailedDialog({ error, onRetry, onUnsigned }: { error: GitErrorInfo; onRetry: () => void; onUnsigned: () => void }): React.JSX.Element {
  const [showDetails, setShowDetails] = useState(false);
  const details = [error.command ? `$ ${error.command}` : '', error.stderr, error.stdout].filter(Boolean).join('\n');
  const keyMissing = error.code === 'signing-key-missing';
  return (
    <Dialog
      title="Commit could not be signed"
      icon="lock"
      onClose={closeDialog}
      footer={
        <>
          {details ? (
            <span className="left">
              <Button variant="ghost" size="sm" onClick={() => setShowDetails((v) => !v)}>{showDetails ? 'Hide details' : 'Show details'}</Button>
            </span>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              closeDialog();
              openDialog({ kind: 'settings', tab: 'git' });
            }}
          >
            Open signing settings
          </Button>
          <Button
            onClick={() => {
              closeDialog();
              onUnsigned();
            }}
          >
            Commit unsigned this time
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              closeDialog();
              onRetry();
            }}
          >
            Retry
          </Button>
        </>
      }
    >
      <p className="selectable">{error.message}</p>
      <Callout tone="info">
        {keyMissing
          ? 'The configured signing key could not be found. You can commit unsigned this time, or fix the key from signing settings.'
          : 'Signing most likely failed because a passphrase is required and no agent has it cached. GitGood cannot show terminal prompts, so a graphical pinentry or a running agent with the passphrase already unlocked is needed.'}
      </Callout>
      {showDetails && details ? <pre className="details-block">{details}</pre> : null}
    </Dialog>
  );
}

export function SquashDialog({ shas, targetSha }: { shas: string[]; targetSha: string }): React.JSX.Element {
  const commits = useAppStore((s) => s.history.commits.filter((c) => shas.includes(c.sha)));
  const target = commits.find((c) => c.sha === targetSha) ?? commits[commits.length - 1];
  const initial = [...commits].reverse();
  const [summary, setSummary] = useState(target?.summary ?? '');
  const [description, setDescription] = useState(() => initial.map((c) => (c.sha === target?.sha ? c.body : `${c.summary}${c.body ? `\n\n${c.body}` : ''}`)).filter(Boolean).join('\n\n'));
  const [busy, setBusy] = useState(false);
  const unpushedOnly = useAppStore((s) => { const ahead = s.status?.branch.ahead ?? 0; const idx = shas.map((sha) => s.history.commits.findIndex((c) => c.sha === sha)); return s.status?.branch.upstream ? idx.every((i) => i >= 0 && i < ahead) : true; });
  return (
    <Dialog
      title={`Squash ${shas.length} commits`}
      icon="squash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!summary.trim()} loading={busy} onClick={async () => { setBusy(true); await actions.squashCommits(shas, targetSha, `${summary.trim()}\n\n${description.trim()}`.trim()); setBusy(false); }}>Squash commits</Button>
        </>
      }
    >
      <TextField label="Summary" value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus />
      <div className="field">
        <label>Description</label>
        <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {!unpushedOnly ? <Callout tone="warning">Some of these commits have already been pushed. Squashing rewrites history and will require a force push.</Callout> : null}
      <div className="file-preview-list">
        {initial.map((c) => (
          <div key={c.sha}>
            <span className="muted">{c.shortSha}</span> {c.summary}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function RewordDialog({ commit }: { commit: Commit }): React.JSX.Element {
  const [summary, setSummary] = useState(commit.summary);
  const [description, setDescription] = useState(commit.body);
  const [busy, setBusy] = useState(false);
  const pushed = useAppStore((s) => { const idx = s.history.commits.findIndex((c) => c.sha === commit.sha); return s.status?.branch.upstream ? idx >= (s.status?.branch.ahead ?? 0) : false; });
  return (
    <Dialog
      title="Edit commit message"
      icon="pencil"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!summary.trim()} loading={busy} onClick={async () => { setBusy(true); await actions.rewordCommit(commit.sha, `${summary.trim()}\n\n${description.trim()}`.trim()); setBusy(false); }}>Save message</Button>
        </>
      }
    >
      <TextField label="Summary" value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus />
      <div className="field">
        <label>Description</label>
        <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {pushed ? <Callout tone="warning">This commit has already been pushed. Editing it rewrites history and will require a force push.</Callout> : null}
    </Dialog>
  );
}

export function TagDialog({ sha }: { sha: string }): React.JSX.Element {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^[^\s~^:?*[\\]+$/.test(name.trim()) && !name.includes('..');
  useEffect(() => undefined, []);
  return (
    <Dialog
      title="Create a tag"
      icon="tag"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={async () => { setBusy(true); await actions.createTag(name.trim(), sha, message.trim() || null); setBusy(false); }}>Create tag</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (valid) void actions.createTag(name.trim(), sha, message.trim() || null); }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} placeholder="v1.0.0" hint={`Tag will point at ${sha.slice(0, 7)}`} />
      </form>
      <div className="field">
        <label>Message (optional, creates an annotated tag)</label>
        <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
    </Dialog>
  );
}
