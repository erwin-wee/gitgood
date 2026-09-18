import React, { useState } from 'react';
import type { Stash } from '@shared/types';
import { isValidBranchName, sanitizeBranchName } from '@shared/util';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Button, Callout, Checkbox, Dialog, TextField } from '../ui';

export function BranchFromStashDialog({ stash }: { stash: Stash }): React.JSX.Element {
  const branches = useAppStore((s) => s.branches);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const sanitized = sanitizeBranchName(name);
  const exists = branches.some((b) => b.kind === 'local' && b.name === sanitized);
  const valid = sanitized.length > 0 && isValidBranchName(sanitized) && !exists;

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    await actions.createBranchFromStash(stash, sanitized);
    setBusy(false);
  };

  return (
    <Dialog
      title="Create a branch from stash"
      icon="branch"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!valid} loading={busy}>Create branch</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          spellCheck={false}
          hint={sanitized && sanitized !== name.trim() ? `Will be created as ${sanitized}` : undefined}
          error={exists ? 'A branch with this name already exists.' : name && !valid && sanitized ? 'That name is not a valid branch name.' : undefined}
        />
      </form>
      <Callout tone="info" icon="stash">
        The branch is created at the stash's parent commit, checked out with <span className="mono">{stash.message}</span> applied, and the stash is then removed.
      </Callout>
    </Dialog>
  );
}

export function StashSelectedFilesDialog({ paths }: { paths: string[] }): React.JSX.Element {
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await actions.stashSelectedFiles(paths, message, includeUntracked);
    setBusy(false);
  };

  return (
    <Dialog
      title={paths.length === 1 ? 'Stash selected file' : `Stash ${paths.length} selected files`}
      icon="stash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>Stash {paths.length} file{paths.length === 1 ? '' : 's'}</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <TextField label="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} autoFocus placeholder="Stashed changes" />
      </form>
      <div className="file-preview-list">
        {paths.slice(0, 20).map((p) => (
          <div key={p}>{p}</div>
        ))}
        {paths.length > 20 ? <div className="muted">…and {paths.length - 20} more</div> : null}
      </div>
      <Checkbox checked={includeUntracked} onChange={setIncludeUntracked} label="Include untracked files among the selection" />
      <p className="muted" style={{ fontSize: 12 }}>The rest of the working tree is left untouched.</p>
    </Dialog>
  );
}
