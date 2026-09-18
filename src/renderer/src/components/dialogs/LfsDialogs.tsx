import React, { useEffect, useState } from 'react';
import { formatBytes } from '@shared/util';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, useAppStore } from '../../state/store';
import { Badge, Button, Callout, Dialog, Icon, Spinner, TextField } from '../ui';

export function LfsDialog(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.lfsStatus);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);

  useEffect(() => {
    setLoading(true);
    void actions.refreshSubmodulesAndLfs().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  const track = async () => {
    const p = pattern.trim();
    if (!p) return;
    setBusy('track');
    await actions.setLfsTracking(p, true);
    setPattern('');
    setBusy(null);
  };

  const untrack = async (p: string) => {
    setBusy(p);
    await actions.setLfsTracking(p, false);
    setBusy(null);
  };

  const prune = async () => {
    if (!repo) return;
    setPruning(true);
    try {
      const dryRun = await invoke('git.lfs.prune', repo.path, true);
      if (!dryRun.objects) {
        setPruning(false);
        return;
      }
      openDialog({
        kind: 'confirm',
        title: 'Prune Git LFS objects',
        message: `This deletes ${dryRun.objects} local object${dryRun.objects === 1 ? '' : 's'} (${formatBytes(dryRun.bytes)}) that are not referenced by any recent commit or unpushed change. They can be re-downloaded later with Fetch or Pull.`,
        confirmLabel: 'Prune',
        danger: true,
        onConfirm: () => void actions.pruneLfsObjects(),
      });
    } catch (err) {
      actions.showError('Could not check what would be pruned', err);
    } finally {
      setPruning(false);
    }
  };

  const notInstalled = !!status && !status.installed;

  return (
    <Dialog
      title="Git LFS"
      icon="download"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button variant="ghost" icon="download" disabled={notInstalled || !status?.usedByRepo} onClick={() => void actions.fetchLfsObjects('fetch-all', null)}>
            Fetch all
          </Button>
          <Button variant="ghost" icon="download" disabled={notInstalled || !status?.usedByRepo} onClick={() => void actions.fetchLfsObjects('pull', null)}>
            Pull
          </Button>
          <Button variant="ghost" disabled={notInstalled || !status?.trackedFiles} loading={pruning} onClick={() => void prune()}>
            Prune…
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={closeDialog}>Close</Button>
        </>
      }
    >
      {loading && !status ? (
        <div className="list-empty">
          <Spinner /> Loading Git LFS status…
        </div>
      ) : !status ? (
        <div className="list-empty">Could not read Git LFS status.</div>
      ) : (
        <>
          {notInstalled ? (
            <Callout tone={status.usedByRepo ? 'warning' : 'info'} icon="alert">
              Git LFS is not installed{status.usedByRepo ? '; this repository uses it' : ''}. Install it from{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); void actions.openExternal('https://git-lfs.com'); }}>
                git-lfs.com
              </a>
              , then reopen this dialog.
            </Callout>
          ) : (
            <div className="status-card">
              <div className="status-card-row">
                <span className="muted">Version</span>
                <span className="mono">{status.version ?? 'unknown'}</span>
              </div>
              <div className="status-card-row">
                <span className="muted">Hooks</span>
                <span>
                  {status.hooksInstalled ? <Badge tone="success">installed</Badge> : <Badge tone="danger">not installed</Badge>}
                  {!status.hooksInstalled ? (
                    <Button size="sm" variant="ghost" onClick={() => void actions.installLfsHooks()} style={{ marginLeft: 8 }}>
                      Install hooks
                    </Button>
                  ) : null}
                </span>
              </div>
              <div className="status-card-row">
                <span className="muted">Tracked files</span>
                <span>{status.trackedFiles}</span>
              </div>
              <div className="status-card-row">
                <span className="muted">Local objects</span>
                <span>{status.localBytes !== null ? formatBytes(status.localBytes) : '—'}</span>
              </div>
              {status.missingFiles ? (
                <div className="status-card-row">
                  <span className="muted">Missing objects</span>
                  <span>{status.missingFiles} not downloaded</span>
                </div>
              ) : null}
              {!status.hooksInstalled ? <Callout tone="warning">Without hooks, pushing from GitGood (or the command line) uploads pointer files only, not the real objects.</Callout> : null}
            </div>
          )}

          <h4 style={{ margin: '16px 0 8px' }}>Tracked patterns</h4>
          {status.patterns.length ? (
            <div className="file-preview-list">
              {status.patterns.map((p) => (
                <div key={p} className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1 }}>{p}</span>
                  <Button size="sm" variant="ghost" loading={busy === p} disabled={notInstalled} onClick={() => void untrack(p)}>
                    Untrack
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>No patterns tracked yet.</p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <TextField placeholder="e.g. *.psd" value={pattern} onChange={(e) => setPattern(e.target.value)} spellCheck={false} disabled={notInstalled} />
            <Button variant="primary" loading={busy === 'track'} disabled={notInstalled || !pattern.trim()} onClick={() => void track()}>
              Track
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
