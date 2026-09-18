import React, { useEffect, useState } from 'react';
import type { Submodule } from '@shared/types';
import { invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Badge, Button, Callout, Dialog, Icon, Spinner, openContextMenu, type MenuItem } from '../ui';

const STATE_LABEL: Record<Submodule['state'], string> = {
  'up-to-date': 'Up to date',
  uninitialized: 'Not initialized',
  modified: 'Modified',
  differs: 'Differs from recorded',
  conflicted: 'Conflicted',
  missing: 'Missing',
};

const STATE_TONE: Record<Submodule['state'], 'neutral' | 'success' | 'danger' | 'attention' | 'accent' | 'done'> = {
  'up-to-date': 'success',
  uninitialized: 'attention',
  modified: 'accent',
  differs: 'attention',
  conflicted: 'danger',
  missing: 'danger',
};

export function SubmodulesDialog(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const submodules = useAppStore((s) => s.submodules);
  const [loading, setLoading] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void actions.refreshSubmodulesAndLfs().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  const uninitialized = submodules.filter((s) => s.state === 'uninitialized');

  const withBusy = async (path: string, fn: () => Promise<void>) => {
    setBusyPath(path);
    try {
      await fn();
    } finally {
      setBusyPath(null);
    }
  };

  const rowMenu = (sub: Submodule): MenuItem[] => [
    { label: sub.state === 'uninitialized' ? 'Initialize' : 'Update to recorded commit', onClick: () => void withBusy(sub.path, () => actions.updateSubmodule(sub.path, sub.state === 'uninitialized')) },
    { label: 'Open as repository', onClick: () => void actions.openSubmoduleAsRepository(sub.path), disabled: sub.state === 'uninitialized' },
    { label: 'Show in file manager', onClick: () => repo && void invoke('app.joinPath', repo.path, ...sub.path.split('/')).then((p) => actions.showInFolderAt(p)), disabled: sub.state === 'uninitialized' },
    { type: 'separator' },
    { label: 'Copy URL', onClick: () => void actions.copyToClipboard(sub.url, 'URL copied') },
  ];

  return (
    <Dialog
      title="Submodules"
      icon="folder"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          {uninitialized.length ? (
            <Button variant="ghost" onClick={() => void actions.initializeAndUpdateAllSubmodules()}>
              Initialize and update all
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => void actions.syncSubmoduleUrls()} disabled={!submodules.length}>
            Sync URLs
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={closeDialog}>Close</Button>
        </>
      }
    >
      {loading && !submodules.length ? (
        <div className="list-empty">
          <Spinner /> Loading submodules…
        </div>
      ) : !submodules.length ? (
        <div className="list-empty">This repository has no submodules.</div>
      ) : (
        <div className="popover-list" style={{ maxHeight: 'none' }}>
          {submodules.map((sub) => (
            <div key={sub.path} className="list-row" onContextMenu={(e) => openContextMenu(e, rowMenu(sub))}>
              <Icon name="folder" />
              <span className="row-main">
                <span className="truncate">
                  {sub.path} {sub.nested ? <Badge title="Submodule of a submodule">nested</Badge> : null} <Badge tone={STATE_TONE[sub.state]}>{STATE_LABEL[sub.state]}</Badge>
                </span>
                <span className="row-sub truncate mono" title={sub.url}>
                  {sub.url}
                  {sub.recordedSha ? ` · recorded ${sub.recordedSha.slice(0, 7)}` : ''}
                  {sub.checkedOutSha && sub.checkedOutSha !== sub.recordedSha ? ` · checked out ${sub.checkedOutSha.slice(0, 7)}` : ''}
                </span>
              </span>
              {busyPath === sub.path ? <Spinner /> : <Button size="sm" variant="ghost" iconOnly icon="kebab" onClick={(e) => openContextMenu(e, rowMenu(sub))} />}
            </div>
          ))}
        </div>
      )}
      {submodules.some((s) => s.state === 'conflicted') ? <Callout tone="danger">One or more submodules have merge conflicts; resolve them from the command line inside the submodule.</Callout> : null}
    </Dialog>
  );
}
