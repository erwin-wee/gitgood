import React, { useState } from 'react';
import type { StaleBranch } from '@shared/types';
import { shortSha } from '@shared/util';
import * as actions from '../../state/actions';
import { closeDialog } from '../../state/store';
import { Button, Checkbox, Dialog } from '../ui';

const REASON_LABELS: Record<string, string> = { merged: 'merged', inactive: 'inactive', gone: 'upstream gone' };

/** Confirms and performs a bulk deletion of stale local branches, listing each with its reason and tip commit, with an off-by-default option to also delete the remote branch. */
export function BulkDeleteBranchesDialog({ branches }: { branches: StaleBranch[] }): React.JSX.Element {
  const deletable = branches.filter((b) => !b.protected);
  const [selected, setSelected] = useState<Set<string>>(new Set(deletable.map((b) => b.name)));
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = (name: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await actions.bulkDeleteStaleBranches([...selected], deleteRemote);
    } finally {
      setBusy(false);
      closeDialog();
    }
  };

  return (
    <Dialog
      title="Delete stale branches"
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!selected.size} onClick={() => void confirm()}>
            Delete {selected.size} branch{selected.size === 1 ? '' : 'es'}
          </Button>
        </>
      }
    >
      <p>These local branches will be permanently deleted. Their tip commits stay reachable through git&apos;s reflog for a while, and GitGood offers an Undo right after.</p>
      <div className="file-preview-list">
        {deletable.map((b) => (
          <label key={b.name} className="checkbox" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <input type="checkbox" checked={selected.has(b.name)} onChange={() => toggle(b.name)} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
            <span className="muted" style={{ fontSize: 11 }}>
              {b.reason.map((r) => REASON_LABELS[r] ?? r).join(', ')} · {shortSha(b.sha)}
            </span>
          </label>
        ))}
      </div>
      <Checkbox checked={deleteRemote} onChange={setDeleteRemote} label="Also delete the remote branch, where one exists" />
    </Dialog>
  );
}
