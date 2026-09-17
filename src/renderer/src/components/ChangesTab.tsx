import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitFile, Stash, WorkingFile } from '@shared/types';
import { extname } from '@shared/util';
import { invoke, isMac } from '../api';
import * as actions from '../state/actions';
import { openDialog, patchChanges, store, useAppStore } from '../state/store';
import { Avatar, Button, Checkbox, Icon, PathLabel, RelativeTime, Spinner, openContextMenu, statusIcon, statusLabel, type MenuItem } from './ui';

const SUMMARY_LIMIT = 72;

export function ChangesTab(): React.JSX.Element {
  const status = useAppStore((s) => s.status);
  const changes = useAppStore((s) => s.changes);
  const stashes = useAppStore((s) => s.stashes);
  const focused = useAppStore((s) => s.focused);
  const ai = useAppStore((s) => s.ai);
  const [filter, setFilter] = useState('');
  const files = status?.files ?? [];
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  const includedCount = files.filter((f) => !changes.excluded.includes(f.path)).length;
  const partialCount = Object.keys(changes.partial).length;
  const allState: boolean | 'indeterminate' = files.length === 0 ? false : includedCount === files.length && partialCount === 0 ? true : includedCount === 0 ? false : 'indeterminate';

  const contextMenu = (e: React.MouseEvent, file: WorkingFile) => {
    const s = store.get();
    const selected = s.changes.selectedPaths.includes(file.path) ? s.changes.selectedPaths : [file.path];
    if (!s.changes.selectedPaths.includes(file.path)) actions.selectWorkingFile(file.path);
    const ext = extname(file.path);
    const items: MenuItem[] = [];
    if (file.conflict) {
      items.push(
        { label: 'Resolve with AI', icon: 'sparkle', onClick: () => void actions.resolveWithAi(file.path), disabled: s.settings?.ai.provider === 'disabled' || s.aiBusy },
        { label: `Use ${s.status?.operation.kind === 'rebase' ? 'upstream' : 'current branch'} version (ours)`, onClick: () => void actions.useSide(file.path, 'ours') },
        { label: `Use ${s.status?.operation.kind === 'rebase' ? 'rebased commit' : 'incoming'} version (theirs)`, onClick: () => void actions.useSide(file.path, 'theirs') },
        { label: 'Mark as resolved', onClick: () => void actions.markResolved([file.path]) },
        { type: 'separator' },
      );
    }
    items.push(
      { label: selected.length > 1 ? `Discard ${selected.length} selected changes…` : 'Discard changes…', danger: true, onClick: () => actions.requestDiscard(selected, false) },
      { label: 'Discard all changes…', danger: true, onClick: () => actions.requestDiscard(files.map((f) => f.path), true) },
      { type: 'separator' },
      { label: selected.length > 1 ? 'Include selected in commit' : 'Include in commit', onClick: () => patchChanges((c) => ({ excluded: c.excluded.filter((p) => !selected.includes(p)) })) },
      { label: selected.length > 1 ? 'Exclude selected from commit' : 'Exclude from commit', onClick: () => patchChanges((c) => ({ excluded: [...new Set([...c.excluded, ...selected])], partial: Object.fromEntries(Object.entries(c.partial).filter(([p]) => !selected.includes(p))) })) },
      { type: 'separator' },
      { label: 'Ignore file (add to .gitignore)', onClick: () => void actions.ignore(selected.map((p) => `/${p}`)) },
      ...(ext ? [{ label: `Ignore all ${ext} files (add to .gitignore)`, onClick: () => void actions.ignore([`*${ext}`]) }] : []),
      { type: 'separator' },
      { label: isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => void actions.showInFolder(file.status === 'deleted' ? null : file.path), shortcut: `${isMac ? '⌘' : 'Ctrl'}+Shift+F` },
      { label: 'Open in external editor', onClick: () => void actions.openInEditor(file.status === 'deleted' ? null : file.path), disabled: file.status === 'deleted', shortcut: `${isMac ? '⌘' : 'Ctrl'}+Shift+A` },
      { label: 'Open with default program', onClick: () => void invoke('app.joinPath', s.currentRepo!.path, ...file.path.split('/')).then((p) => invoke('app.openPath', p)), disabled: file.status === 'deleted' },
      { type: 'separator' },
      { label: 'Copy file path', onClick: () => void invoke('app.joinPath', s.currentRepo!.path, ...file.path.split('/')).then((p) => actions.copyToClipboard(p, 'Path copied')) },
      { label: 'Copy relative file path', onClick: () => void actions.copyToClipboard(file.path, 'Path copied') },
    );
    openContextMenu(e, items);
  };

  return (
    <>
      <div className="changes-header">
        <Checkbox checked={allState} onChange={(v) => actions.setAllIncluded(v)} disabled={files.length === 0 || !!status?.hasConflicts} title="Include all changes in commit" />
        <span className="count">
          {files.length === 0 ? 'No changes' : `${files.length} changed file${files.length === 1 ? '' : 's'}`}
          {status?.hasConflicts ? <span className="muted"> · {files.filter((f) => f.conflict).length} conflicted</span> : null}
        </span>
        {files.length > 8 ? (
          <span className="filter-input" style={{ flex: '0 0 130px' }}>
            <Icon name="filter" />
            <input id="changes-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: '2px 4px 2px 26px', fontSize: 12 }} />
          </span>
        ) : null}
      </div>
      <div className="file-list" onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.file-row')) return; if (files.length) openContextMenu(e, [{ label: 'Discard all changes…', danger: true, onClick: () => actions.requestDiscard(files.map((f) => f.path), true) }, { label: 'Stash all changes', onClick: () => void actions.stashAll() }]); }}>
        {status && files.length === 0 && !changes.showingStash ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <Icon name="check-circle" size={28} />
            <p>{status.branch.unborn ? 'This repository has no commits yet. Add some files to make your first commit.' : 'No local changes.'}</p>
          </div>
        ) : null}
        {visible.map((file) => {
          const included = changes.excluded.includes(file.path) ? false : changes.partial[file.path] ? 'indeterminate' : true;
          const selected = changes.selectedPaths.includes(file.path) && !changes.showingStash;
          const aiState = ai[file.path];
          return (
            <div
              key={file.path}
              className={`file-row ${selected ? 'selected' : ''} ${selected && !focused ? 'inactive' : ''}`}
              onClick={(e) => actions.selectWorkingFile(file.path, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
              onContextMenu={(e) => contextMenu(e, file)}
              onDoubleClick={() => void actions.openInEditor(file.path)}
            >
              <Checkbox checked={included} onChange={() => actions.toggleIncluded(file.path)} disabled={!!file.conflict} title={file.conflict ? 'Resolve the conflict before committing' : included === true ? 'Exclude from commit' : 'Include in commit'} />
              <PathLabel path={file.path} />
              {aiState && aiState.phase !== 'done' && aiState.phase !== 'error' ? <Spinner /> : null}
              {file.conflict ? <span className="badge danger" title={file.conflict.replace(/-/g, ' ')}>conflict</span> : null}
              <span className={`status-icon ${file.status}`} title={file.status === 'renamed' && file.oldPath ? `Renamed from ${file.oldPath}` : statusLabel(file.status)}>
                <Icon name={statusIcon(file.status)} />
              </span>
            </div>
          );
        })}
      </div>
      {stashes.length ? <StashSection stashes={stashes} /> : null}
      <CommitForm />
    </>
  );
}

function StashSection({ stashes }: { stashes: Stash[] }): React.JSX.Element {
  const showing = useAppStore((s) => s.changes.showingStash);
  const branch = useAppStore((s) => s.status?.branch.name ?? null);
  const sorted = useMemo(() => [...stashes].sort((a, b) => (a.branch === branch ? -1 : b.branch === branch ? 1 : a.index - b.index)), [stashes, branch]);
  return (
    <div className="stash-section">
      <div className="list-group-header">Stashed changes ({stashes.length})</div>
      {sorted.map((st) => (
        <div
          key={st.sha}
          className={`stash-row ${showing?.sha === st.sha ? 'selected' : ''}`}
          onClick={() => void actions.viewStash(showing?.sha === st.sha ? null : st)}
          onContextMenu={(e) =>
            openContextMenu(e, [
              { label: 'Restore (pop)', onClick: () => void actions.restoreStash(st, true) },
              { label: 'Apply (keep stash)', onClick: () => void actions.restoreStash(st, false) },
              { type: 'separator' },
              { label: 'Discard stash…', danger: true, onClick: () => void actions.dropStash(st) },
            ])
          }
        >
          <Icon name="stash" />
          <span className="row-main">
            <span className="truncate">{st.message}</span>
            <span className="row-sub truncate">
              {st.branch ? `On ${st.branch} · ` : ''}
              <RelativeTime date={st.date} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function StashView(): React.JSX.Element | null {
  const stash = useAppStore((s) => s.changes.showingStash);
  const files = useAppStore((s) => s.changes.stashFiles);
  const selected = useAppStore((s) => s.changes.stashSelectedFile);
  if (!stash) return null;
  return (
    <div className="commit-details">
      <div className="commit-summary">
        <h3>
          <Icon name="stash" /> {stash.message}
        </h3>
        <div className="meta-row">
          <span>{stash.ref}</span>
          {stash.branch ? <span>on {stash.branch}</span> : null}
          <RelativeTime date={stash.date} />
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="primary" onClick={() => void actions.restoreStash(stash, true)}>Restore</Button>
          <Button size="sm" onClick={() => void actions.restoreStash(stash, false)}>Apply</Button>
          <Button size="sm" variant="danger" onClick={() => void actions.dropStash(stash)}>Discard</Button>
          <Button size="sm" variant="ghost" iconOnly icon="x" title="Back to changes" onClick={() => void actions.viewStash(null)} />
        </div>
      </div>
      <div className="commit-body">
        <div className="commit-files">
          <div className="changes-header">
            <span className="count">{files.length} changed file{files.length === 1 ? '' : 's'}</span>
          </div>
          <div className="file-list">
            {files.map((f) => (
              <CommitFileRow key={f.path} file={f} selected={selected === f.path} onSelect={() => actions.selectStashFile(f.path)} />
            ))}
          </div>
        </div>
        <StashDiffSlot />
      </div>
    </div>
  );
}

function StashDiffSlot(): React.JSX.Element {
  // Rendered by App via the shared DiffPane; kept as a slot for layout symmetry.
  return <div id="stash-diff-slot" style={{ display: 'flex', flex: 1, minWidth: 0 }} />;
}

export function CommitFileRow({ file, selected, onSelect, onContextMenu }: { file: CommitFile; selected: boolean; onSelect: () => void; onContextMenu?: (e: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <div className={`file-row ${selected ? 'selected' : ''}`} onClick={onSelect} onContextMenu={onContextMenu}>
      <PathLabel path={file.path} />
      {file.additions !== null || file.deletions !== null ? (
        <span className="stats">
          {file.additions ? <span className="stat-add">+{file.additions}</span> : null}
          {file.deletions ? <span className="stat-del">−{file.deletions}</span> : null}
        </span>
      ) : null}
      <span className={`status-icon ${file.status}`} title={file.status === 'renamed' && file.oldPath ? `Renamed from ${file.oldPath}` : statusLabel(file.status)}>
        <Icon name={statusIcon(file.status)} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit form
// ---------------------------------------------------------------------------

function CommitForm(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const changes = useAppStore((s) => s.changes);
  const settings = useAppStore((s) => s.settings);
  const aiCommitBusy = useAppStore((s) => s.aiCommitBusy);
  const [identity, setIdentity] = useState<{ name: string | null; email: string | null } | null>(null);
  const [coAuthorInput, setCoAuthorInput] = useState('');
  const summaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    void invoke('repo.config', repo.path)
      .then((c) => !cancelled && setIdentity(c.effective))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const files = status?.files ?? [];
  const included = files.filter((f) => !changes.excluded.includes(f.path));
  const inMerge = status?.operation.kind === 'merge' || status?.operation.kind === 'cherry-pick' || status?.operation.kind === 'revert';
  const summaryTooLong = changes.summary.length > SUMMARY_LIMIT;
  const branchName = status?.branch.name ?? 'HEAD';
  const canCommit = !!status && !changes.committing && !status.hasConflicts && (changes.amend || (included.length > 0 && (changes.summary.trim().length > 0 || inMerge)));
  const label = changes.committing ? 'Committing…' : changes.amend ? 'Amend last commit' : inMerge ? `Commit ${status?.operation.kind === 'merge' ? 'merge' : status?.operation.kind}` : status?.branch.detached ? 'Commit to detached HEAD' : `Commit to ${branchName}`;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) {
      e.preventDefault();
      void actions.commit();
    }
  };

  const addCoAuthor = () => {
    const text = coAuthorInput.trim();
    if (!text) return;
    const m = /^(.*?)\s*<([^>]+)>$/.exec(text);
    const entry = m ? { name: m[1].trim() || m[2].split('@')[0], email: m[2].trim() } : text.includes('@') ? { name: text.split('@')[0], email: text } : null;
    if (!entry) return;
    patchChanges((c) => ({ coAuthors: c.coAuthors.some((a) => a.email === entry.email) ? c.coAuthors : [...c.coAuthors, entry] }));
    setCoAuthorInput('');
  };

  const placeholderSummary = inMerge && status?.operation.message ? status.operation.message.split('\n')[0] : 'Summary (required)';

  return (
    <form
      className="commit-form"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        if (canCommit) void actions.commit();
      }}
    >
      <div className="summary-row">
        <Avatar email={identity?.email ?? ''} name={identity?.name ?? undefined} size={24} />
        <input
          id="commit-summary"
          ref={summaryRef}
          className={summaryTooLong ? 'warn' : ''}
          placeholder={placeholderSummary}
          value={changes.summary}
          onChange={(e) => patchChanges({ summary: e.target.value })}
          disabled={changes.committing}
          spellCheck
          autoComplete="off"
        />
        {settings?.ai.provider !== 'disabled' ? (
          <Button variant="ghost" iconOnly icon="sparkle" className="sparkle" loading={aiCommitBusy} title="Generate commit message with AI" onClick={() => void actions.generateCommitMessage()} disabled={included.length === 0 || changes.committing} />
        ) : null}
      </div>
      {summaryTooLong && settings?.showCommitLengthWarning !== false ? (
        <span className="length-warning">
          <Icon name="alert" size={12} /> Great commit summaries are 72 characters or fewer ({changes.summary.length}).
        </span>
      ) : null}
      <textarea placeholder="Description" value={changes.description} onChange={(e) => patchChanges({ description: e.target.value })} disabled={changes.committing} spellCheck />
      {changes.showCoAuthors ? (
        <div className="coauthors">
          {changes.coAuthors.map((a) => (
            <span key={a.email} className="coauthor-chip" title={a.email}>
              {a.name}
              <button type="button" onClick={() => patchChanges((c) => ({ coAuthors: c.coAuthors.filter((x) => x.email !== a.email) }))} title="Remove">
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <input
            style={{ flex: 1, minWidth: 140, padding: '2px 6px', fontSize: 12 }}
            placeholder="Co-author: Name <email>"
            value={coAuthorInput}
            onChange={(e) => setCoAuthorInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addCoAuthor();
              }
            }}
            onBlur={addCoAuthor}
          />
        </div>
      ) : null}
      <div className="form-actions">
        <div className="left">
          <Button variant="ghost" size="sm" icon="person" title={changes.showCoAuthors ? 'Remove co-authors' : 'Add co-authors'} onClick={() => patchChanges((c) => ({ showCoAuthors: !c.showCoAuthors }))} />
          <Checkbox checked={changes.amend} onChange={(v) => void actions.setAmend(v)} label="Amend last commit" disabled={changes.committing || !!status?.branch.unborn || inMerge} />
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {included.length} of {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>
      <Button type="submit" variant="primary" className="commit-btn" disabled={!canCommit} loading={changes.committing} icon={changes.amend ? 'pencil' : 'commit'} title={`${isMac ? '⌘' : 'Ctrl'}+Enter`}>
        {label}
      </Button>
      {status?.hasConflicts ? (
        <Button variant="ghost" size="sm" icon="alert" onClick={() => openDialog({ kind: 'conflicts' })}>
          Resolve conflicts before committing
        </Button>
      ) : null}
    </form>
  );
}
