import React, { useEffect, useMemo, useState } from 'react';
import type { Stash } from '@shared/types';
import * as actions from '../state/actions';
import { openDialog, useAppStore } from '../state/store';
import { CommitFileRow } from './ChangesTab';
import { onListKeyDown } from '../lib/listKeys';
import { Button, Icon, RelativeTime, Spinner, openContextMenu, type MenuItem } from './ui';

const FILE_PAGE = 2000;

function stashMenu(stash: Stash): MenuItem[] {
  return [
    { label: 'Apply (keep stash)', onClick: () => void actions.applyStash(stash) },
    { label: 'Pop (apply and drop)', onClick: () => void actions.popStash(stash) },
    { type: 'separator' },
    { label: 'Create branch from stash…', icon: 'branch', onClick: () => openDialog({ kind: 'branch-from-stash', stash }) },
    { label: 'Copy SHA', onClick: () => void actions.copyToClipboard(stash.sha, 'SHA copied') },
    { type: 'separator' },
    { label: 'Drop…', danger: true, onClick: () => void actions.dropStashView(stash) },
  ];
}

/** Full-screen view (list, file list, diff) for browsing and acting on every stash in the repository. */
export function StashesView(): React.JSX.Element {
  const stashes = useAppStore((s) => s.stashes);
  const view = useAppStore((s) => s.stashesView);
  const repo = useAppStore((s) => s.currentRepo);
  const [fileLimit, setFileLimit] = useState(FILE_PAGE);

  useEffect(() => {
    void actions.loadStashesView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  useEffect(() => {
    setFileLimit(FILE_PAGE);
  }, [view.selectedSha]);

  // getStashes already returns newest-first (stash@{0} first); index tracks that positional order.
  const sorted = useMemo(() => [...stashes].sort((a, b) => a.index - b.index), [stashes]);
  const selected = sorted.find((st) => st.sha === view.selectedSha) ?? null;

  return (
    <div className="stashes-view">
      <div className="stashes-list">
        <div className="changes-header">
          <Icon name="stash" />
          <span className="count">{stashes.length === 0 ? 'No stashes' : `${stashes.length} stash${stashes.length === 1 ? '' : 'es'}`}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" iconOnly icon="x" title="Back to changes" onClick={() => actions.setView('changes')} />
        </div>
        <div className="file-list" role="listbox" aria-label="Stashes" onKeyDown={onListKeyDown}>
          {view.loading && !stashes.length ? (
            <div className="list-empty">
              <Spinner /> Loading stashes…
            </div>
          ) : null}
          {!view.loading && !stashes.length ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <Icon name="stash" size={28} />
              <p>No stashes.</p>
              <p className="muted" style={{ fontSize: 12 }}>Stash files from the Changes tab context menu, or "Stash all changes" in the Branch menu.</p>
            </div>
          ) : null}
          {sorted.map((st) => (
            <div
              key={st.sha}
              tabIndex={0}
              role="option"
              aria-selected={view.selectedSha === st.sha}
              className={`list-row ${view.selectedSha === st.sha ? 'selected' : ''}`}
              onClick={() => void actions.selectStash(st.sha)}
              onContextMenu={(e) => {
                void actions.selectStash(st.sha);
                openContextMenu(e, stashMenu(st));
              }}
            >
              <Icon name="stash" />
              <span className="row-main">
                <span className="truncate">{st.message}</span>
                <span className="row-sub truncate">
                  {st.branch ? `On ${st.branch}` : 'Unknown branch'} · <RelativeTime date={st.date} />
                  {st.createdByApp ? ' · GitGood' : ''}
                  {st.fileCount !== null ? ` · ${st.fileCount} file${st.fileCount === 1 ? '' : 's'}` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="stashes-files">
        {selected ? (
          <>
            <div className="changes-header">
              <span className="count">{view.files.length} changed file{view.files.length === 1 ? '' : 's'}</span>
            </div>
            <div className="file-list" role="listbox" aria-label="Changed files" onKeyDown={onListKeyDown}>
              {view.filesLoading ? (
                <div className="list-empty">
                  <Spinner />
                </div>
              ) : null}
              {view.files.slice(0, fileLimit).map((f) => (
                <CommitFileRow key={f.path} file={f} selected={view.selectedFile === f.path} onSelect={() => actions.selectStashViewFile(f.path)} />
              ))}
              {view.files.length > fileLimit ? (
                <div className="load-more">
                  <Button size="sm" variant="ghost" onClick={() => setFileLimit((n) => n + FILE_PAGE)}>
                    Show more ({view.files.length - fileLimit} remaining)
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="stash-actions">
              <Button size="sm" variant="primary" onClick={() => void actions.popStash(selected)}>Pop</Button>
              <Button size="sm" onClick={() => void actions.applyStash(selected)}>Apply</Button>
              <Button size="sm" onClick={() => openDialog({ kind: 'branch-from-stash', stash: selected })}>Create branch…</Button>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="danger" onClick={() => void actions.dropStashView(selected)}>Drop…</Button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Icon name="stash" size={28} />
            <p>Select a stash to see its files.</p>
          </div>
        )}
      </div>
      <div id="stashes-diff-slot" style={{ display: 'flex', flex: 1, minWidth: 0 }} />
    </div>
  );
}
