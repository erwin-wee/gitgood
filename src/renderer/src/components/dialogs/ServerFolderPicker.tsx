import React, { useEffect, useState } from 'react';
import type { EventPayloads } from '@shared/ipc';
import type { IpcResult } from '@shared/types';
import { on } from '../../api';
import { Button, Dialog, Icon, TextField } from '../ui';

type PickRequest = EventPayloads['server.pickDirectory'];

interface Listing {
  path: string | null;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/**
 * Folder picker for a server's filesystem, shown when the web bridge (a browser tab or a desktop client of a remote
 * server) receives `app.chooseDirectory`. Mounted next to the current dialog rather than pushed onto the dialog
 * stack, so the form that asked (Clone, Settings…) keeps its state underneath.
 */
export function ServerFolderPicker(): React.JSX.Element | null {
  const [request, setRequest] = useState<PickRequest | null>(null);
  useEffect(() => on('server.pickDirectory', setRequest), []);
  return request ? (
    <PickerDialog
      request={request}
      onDone={(path) => {
        request.done(path);
        setRequest(null);
      }}
    />
  ) : null;
}

function PickerDialog({ request, onDone }: { request: PickRequest; onDone: (path: string | null) => void }): React.JSX.Element {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');

  /** Lists `path` (null: the allowed roots); on failure keeps the current listing and shows why. */
  const open = async (path: string | null): Promise<Listing | null> => {
    const res = (await window.gitgoodBridge.invokeRaw('app.listDir', path)) as IpcResult<Listing>;
    if (!res.ok) {
      setError(res.error.message);
      return null;
    }
    setError('');
    setListing(res.value);
    setTyped(res.value.path ?? '');
    return res.value;
  };
  useEffect(() => {
    void open(null);
  }, []);

  // A typed but not yet opened path is opened (and so validated and confined by the server) before it is selected.
  const select = async () => {
    const wanted = typed.trim();
    if (wanted && wanted !== listing?.path) {
      const opened = await open(wanted);
      if (opened) onDone(opened.path);
    } else {
      onDone(listing?.path ?? null);
    }
  };

  const row = (key: string, label: string, target: string | null, folder = true) => (
    <div
      key={key}
      className="list-row"
      role="button"
      tabIndex={0}
      onClick={() => void open(target)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void open(target);
        }
      }}
    >
      {folder ? <Icon name="folder" /> : null}
      <span className="row-main truncate">{label}</span>
    </div>
  );

  return (
    <Dialog
      title={request.opts.title ?? 'Choose a folder on the server'}
      icon="folder"
      onClose={() => onDone(null)}
      footer={
        <>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void select()} disabled={!typed.trim()}>Select</Button>
        </>
      }
    >
      <TextField
        label="Path"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void open(typed.trim() || null);
          }
        }}
        placeholder="Type a path and press Enter"
        spellCheck={false}
        autoFocus
        error={error || undefined}
      />
      <div className="file-list" role="group" aria-label="Folders" style={{ maxHeight: 320, marginTop: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
        {listing && (listing.parent !== null || listing.path) ? row('up', '← Up', listing.parent, false) : null}
        {listing?.entries.map((entry) => row(entry.path, entry.name, entry.path))}
        {listing && !listing.entries.length ? <div className="muted" style={{ padding: '8px 12px' }}>No subfolders</div> : null}
      </div>
    </Dialog>
  );
}
