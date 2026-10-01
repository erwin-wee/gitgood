import React, { useEffect, useState } from 'react';
import type { ReflogEntry } from '@shared/types';
import { shortSha } from '@shared/util';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { restoreBranchTo, startBisect } from '../../state/reflog';
import { closeDialog, openDialog, useAppStore } from '../../state/store';
import { Badge, Button, Callout, Dialog, RelativeTime, Spinner, TextField, openContextMenu, type MenuItem } from '../ui';

/** Undo history: HEAD's reflog, with restore / branch / checkout per entry. */
export function ReflogDialog(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const headSha = useAppStore((s) => s.status?.branch.sha ?? null);
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    invoke('repo.reflog', repo.path).then(setEntries, (err) => setError(errorMessage(err)));
  }, [repo]);

  const label = (e: ReflogEntry) => `${e.action}${e.message ? `: ${e.message}` : ''}`;
  const menu = (e: ReflogEntry): MenuItem[] => [
    { label: 'Restore branch to this point…', icon: 'undo', disabled: e.sha === headSha, onClick: () => restoreBranchTo(e.sha, label(e)) },
    { label: 'Create branch here…', icon: 'branch', onClick: () => openDialog({ kind: 'new-branch', startPoint: e.sha, startPointLabel: `${shortSha(e.sha)} ${label(e)}` }) },
    { label: 'Check out (detached)', onClick: () => void actions.checkoutCommit(e.sha), disabled: e.sha === headSha },
  ];

  return (
    <Dialog title="Undo history" icon="history" onClose={closeDialog} width="wide" footer={<Button onClick={closeDialog}>Close</Button>}>
      <p className="muted" style={{ marginTop: 0 }}>
        Every place HEAD has been, newest first. Restore a branch to an earlier point to undo a commit, amend, merge, rebase or reset; nothing is lost until git expires these entries.
      </p>
      {error ? (
        <Callout tone="danger">{error}</Callout>
      ) : !entries ? (
        <div className="list-empty">
          <Spinner /> Loading…
        </div>
      ) : !entries.length ? (
        <div className="list-empty">This repository has no reflog entries yet.</div>
      ) : (
        <div className="popover-list" style={{ maxHeight: 420 }}>
          {entries.map((e) => (
            <div key={e.index} className="list-row" onContextMenu={(ev) => openContextMenu(ev, menu(e))}>
              <span className="row-main">
                <span className="truncate">
                  <Badge>{e.action}</Badge> {e.message} {e.sha === headSha ? <Badge tone="attention">current</Badge> : null}
                </span>
                <span className="row-sub truncate">
                  <RelativeTime date={e.timestamp} /> · <span className="mono">{shortSha(e.sha)}</span>
                </span>
              </span>
              <Button size="sm" disabled={e.sha === headSha} onClick={() => restoreBranchTo(e.sha, label(e))}>Restore…</Button>
              <Button size="sm" variant="ghost" iconOnly icon="kebab" aria-label="More actions" onClick={(ev) => openContextMenu(ev, menu(e))} />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Asks for the known-good end after "mark bad" in History (the bad end is the commit that was right-clicked). */
export function BisectStartDialog({ bad, badLabel }: { bad: string; badLabel: string }): React.JSX.Element {
  const [good, setGood] = useState('');
  const value = good.trim();
  const valid = value !== '' && !value.startsWith('-');
  const submit = () => valid && void startBisect(bad, value);
  return (
    <Dialog
      title="Start bisect"
      icon="history"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>Start bisect</Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        <span className="mono">{badLabel}</span> will be marked <strong>bad</strong>. Git then checks out commits between it and the last one you know was good, so you can test each and mark it good or bad.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <TextField label="Last known good commit" value={good} onChange={(e) => setGood(e.target.value)} autoFocus spellCheck={false} placeholder="v1.2.0, a branch name or a commit hash" />
      </form>
    </Dialog>
  );
}
