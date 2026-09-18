import React, { useEffect, useMemo, useState } from 'react';
import type { Branch, Worktree } from '@shared/types';
import { dirname, sanitizeBranchName, shortSha } from '@shared/util';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, useAppStore } from '../../state/store';
import { BranchPicker } from './BranchDialogs';
import { Badge, Button, Callout, Checkbox, Dialog, Icon, Spinner, TextField, openContextMenu, type MenuItem } from '../ui';

const sep = window.gitgoodBridge.platform === 'win32' ? '\\' : '/';

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

// ---------------------------------------------------------------------------
// Worktrees dialog: list, badges, dirty state, row actions
// ---------------------------------------------------------------------------

export function WorktreesDialog(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  const load = async () => {
    if (!repo) return;
    setLoading(true);
    setError(null);
    try {
      const list = await invoke('repo.worktrees', repo.path);
      setWorktrees(list);
      // Dirty state is computed lazily, only while this dialog is open, one worktree at a time.
      for (const w of list) {
        invoke('repo.status', w.path)
          .then((status) => setDirty((d) => ({ ...d, [w.path]: status.files.length > 0 })))
          .catch(() => undefined);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  const prunable = (worktrees ?? []).filter((w) => w.prunable !== null);

  const rowMenu = (w: Worktree): MenuItem[] => [
    { label: 'Open', onClick: () => void actions.openWorktreeAtPath(w.path), disabled: w.isCurrent },
    { label: 'Show in file manager', onClick: () => void actions.showInFolderAt(w.path) },
    { label: 'Open in editor', onClick: () => void actions.openInEditorAt(w.path) },
    { label: 'Open in terminal', onClick: () => void actions.openInShellAt(w.path) },
    { type: 'separator' },
    w.locked !== null
      ? { label: 'Unlock', onClick: () => void actions.lockWorktree(w, false, null).then(load) }
      : { label: 'Lock…', onClick: () => openDialog({ kind: 'lock-worktree', worktree: w }) },
    { type: 'separator' },
    {
      label: 'Remove…',
      danger: true,
      disabled: w.isMain || w.locked !== null,
      onClick: () => openDialog({ kind: 'remove-worktree', worktree: w }),
    },
  ];

  return (
    <Dialog
      title="Worktrees"
      icon="worktree"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          {prunable.length ? (
            <Button variant="ghost" onClick={() => openDialog({ kind: 'prune-worktrees', worktrees: prunable })}>
              Prune {prunable.length} stale {prunable.length === 1 ? 'entry' : 'entries'}…
            </Button>
          ) : null}
          <span style={{ flex: 1 }} />
          <Button onClick={closeDialog}>Close</Button>
          <Button variant="primary" icon="plus" onClick={() => openDialog({ kind: 'add-worktree' })}>
            Add worktree
          </Button>
        </>
      }
    >
      {loading && !worktrees ? (
        <div className="list-empty">
          <Spinner /> Loading worktrees…
        </div>
      ) : error ? (
        <Callout tone="danger">
          {error}
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void load()}>Retry</Button>
          </div>
        </Callout>
      ) : worktrees && worktrees.length <= 1 ? (
        <div className="list-empty">This repository has no additional worktrees.</div>
      ) : (
        <div className="popover-list" style={{ maxHeight: 'none' }}>
          {(worktrees ?? []).map((w) => (
            <div key={w.path} className={`list-row ${w.isCurrent ? 'selected' : ''}`} onContextMenu={(e) => openContextMenu(e, rowMenu(w))}>
              <Icon name={w.isMain ? 'repo' : 'worktree'} />
              <span className="row-main">
                <span className="truncate">
                  {w.branch ?? `${shortSha(w.head)} (detached)`} {w.isMain ? <Badge>main</Badge> : null} {w.locked !== null ? <Badge tone="attention" title={w.locked || undefined}>locked{w.locked ? `: ${w.locked}` : ''}</Badge> : null} {w.prunable !== null ? <Badge tone="danger" title={w.prunable || undefined}>prunable</Badge> : null}
                </span>
                <span className="row-sub truncate" title={w.path}>
                  {w.path}
                </span>
              </span>
              {dirty[w.path] ? <Icon name="dot-fill" size={12} title="Uncommitted changes" /> : null}
              <Button size="sm" variant="ghost" iconOnly icon="kebab" onClick={(e) => openContextMenu(e, rowMenu(w))} />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add worktree
// ---------------------------------------------------------------------------

type AddMode = 'existing' | 'new' | 'detach';

export function AddWorktreeDialog({ startBranch }: { startBranch?: string | null } = {}): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const settings = useAppStore((s) => s.settings);
  const branches = useAppStore((s) => s.branches);
  const status = useAppStore((s) => s.status);
  const [mode, setMode] = useState<AddMode>(startBranch ? 'existing' : 'new');
  const [branch, setBranch] = useState<Branch | null>(() => (startBranch ? branches.find((b) => b.name === startBranch) ?? null : null));
  const [newBranchName, setNewBranchName] = useState('');
  const [startPoint, setStartPoint] = useState(status?.branch.name ?? 'HEAD');
  const [directory, setDirectory] = useState('');
  const [dirTouched, setDirTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sanitizedNewBranch = sanitizeBranchName(newBranchName);
  const label = mode === 'existing' ? branch?.name ?? '' : mode === 'new' ? sanitizedNewBranch : startPoint.trim() || 'detached';
  const suggestedDir = useMemo(() => {
    if (!repo) return '';
    const base = settings?.defaultWorktreeDirectory?.trim() || dirname(repo.path);
    const name = `${repo.name}-${(label || 'worktree').replace(/[\\/]/g, '-')}`;
    return joinPath(base, name);
  }, [repo, settings?.defaultWorktreeDirectory, label]);
  const targetDir = dirTouched ? directory : suggestedDir;

  const newBranchExists = mode === 'new' && branches.some((b) => b.kind === 'local' && b.name === sanitizedNewBranch);
  const valid = !!repo && !!targetDir.trim() && (mode === 'existing' ? !!branch : mode === 'new' ? sanitizedNewBranch.length > 0 && !newBranchExists : startPoint.trim().length > 0);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const ok = await actions.addWorktree({
      path: targetDir.trim(),
      branch: mode === 'existing' ? branch?.name ?? null : null,
      newBranch: mode === 'new' ? sanitizedNewBranch : null,
      startPoint: mode === 'new' ? startPoint.trim() || null : mode === 'detach' ? startPoint.trim() || 'HEAD' : null,
      detach: mode === 'detach',
    });
    setBusy(false);
    if (!ok) setError('See the notification for details.');
  };

  const chooseDir = async () => {
    const chosen = await invoke('app.chooseDirectory', { title: 'Choose a directory for the worktree', defaultPath: targetDir || undefined });
    if (chosen) {
      setDirectory(chosen);
      setDirTouched(true);
    }
  };

  return (
    <Dialog
      title="Add worktree"
      icon="worktree"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid} loading={busy}>Add worktree</Button>
        </>
      }
    >
      <div className="dialog-tabs" style={{ margin: '-16px -16px 16px', padding: '0 16px' }}>
        <button type="button" className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>Existing branch</button>
        <button type="button" className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>New branch</button>
        <button type="button" className={mode === 'detach' ? 'active' : ''} onClick={() => setMode('detach')}>Detached</button>
      </div>
      {mode === 'existing' ? (
        <div style={{ marginBottom: 12 }}>
          <BranchPicker branches={branches} selected={branch} onSelect={setBranch} exclude={(b) => b.isCurrent} />
        </div>
      ) : null}
      {mode === 'new' ? (
        <>
          <TextField
            label="New branch name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            autoFocus
            spellCheck={false}
            error={newBranchExists ? 'A branch with this name already exists.' : undefined}
            hint={!newBranchExists && sanitizedNewBranch && sanitizedNewBranch !== newBranchName.trim() ? `Will be created as ${sanitizedNewBranch}` : undefined}
          />
          <TextField label="Start point" value={startPoint} onChange={(e) => setStartPoint(e.target.value)} spellCheck={false} hint="A branch, tag or commit SHA to start the new branch from." />
        </>
      ) : null}
      {mode === 'detach' ? <TextField label="Commit" value={startPoint} onChange={(e) => setStartPoint(e.target.value)} autoFocus spellCheck={false} hint="A branch, tag or commit SHA to check out with a detached HEAD." /> : null}
      <TextField label="Directory" value={targetDir} onChange={(e) => { setDirectory(e.target.value); setDirTouched(true); }} spellCheck={false} trailing={<Button onClick={() => void chooseDir()}>Choose…</Button>} />
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Lock worktree
// ---------------------------------------------------------------------------

export function LockWorktreeDialog({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Lock worktree"
      icon="lock"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); await actions.lockWorktree(worktree, true, reason.trim() || null); setBusy(false); }}>Lock</Button>
        </>
      }
    >
      <p className="mono muted" style={{ fontSize: 12 }}>{worktree.path}</p>
      <TextField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="e.g. in use by another process" />
      <p className="muted" style={{ fontSize: 12 }}>A locked worktree cannot be removed until it is unlocked.</p>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Remove worktree (two-step confirmation for a dirty worktree)
// ---------------------------------------------------------------------------

export function RemoveWorktreeDialog({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const platform = window.gitgoodBridge.platform;
  const binName = platform === 'win32' ? 'Recycle Bin' : 'Trash';

  useEffect(() => {
    let cancelled = false;
    void invoke('repo.status', worktree.path)
      .then((status) => !cancelled && setFileCount(status.files.length))
      .catch(() => !cancelled && setFileCount(0))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [worktree.path]);

  const dirty = (fileCount ?? 0) > 0;

  return (
    <Dialog
      title="Remove worktree"
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" loading={busy || checking} disabled={dirty && !confirmed} onClick={async () => { setBusy(true); await actions.removeWorktree(worktree, dirty); setBusy(false); }}>
            Remove worktree
          </Button>
        </>
      }
    >
      <p>
        Remove the worktree at <span className="mono">{worktree.path}</span>? Its directory is deleted, not moved to the {binName}.
      </p>
      {checking ? (
        <Spinner />
      ) : dirty ? (
        <>
          <Callout tone="warning">
            This worktree has {fileCount} uncommitted change{fileCount === 1 ? '' : 's'}. Removing it discards them permanently.
          </Callout>
          <Checkbox checked={confirmed} onChange={setConfirmed} label="I understand, remove it anyway" />
        </>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Prune worktrees
// ---------------------------------------------------------------------------

export function PruneWorktreesDialog({ worktrees }: { worktrees: Worktree[] }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Prune worktrees"
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={async () => { setBusy(true); await actions.pruneWorktrees(); setBusy(false); }}>Prune {worktrees.length}</Button>
        </>
      }
    >
      <p>The following worktree entries no longer exist on disk and will be removed from git's records:</p>
      <div className="file-preview-list">
        {worktrees.map((w) => (
          <div key={w.path} title={w.prunable ?? undefined}>{w.path}</div>
        ))}
      </div>
    </Dialog>
  );
}
