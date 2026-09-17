import React, { useEffect, useRef, useState } from 'react';
import type { Commit } from '@shared/types';
import { isMac } from '../api';
import * as actions from '../state/actions';
import { openDialog, patchHistory, store, useAppStore } from '../state/store';
import { CommitFileRow } from './ChangesTab';
import { Avatar, Badge, Button, FilterInput, Icon, RelativeTime, Spinner, openContextMenu, type MenuItem } from './ui';

function commitMenu(commit: Commit, selected: string[]): MenuItem[] {
  const s = store.get();
  const repo = s.currentRepo;
  const isHead = s.status?.branch.sha === commit.sha;
  const tags = commit.refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
  if (selected.length > 1 && selected.includes(commit.sha)) {
    const target = s.history.commits.filter((c) => selected.includes(c.sha)).pop()!;
    return [
      { label: `Squash ${selected.length} commits…`, icon: 'squash', onClick: () => openDialog({ kind: 'squash', shas: selected, targetSha: target.sha }) },
      { label: `Cherry-pick ${selected.length} commits…`, icon: 'cherry', onClick: () => openDialog({ kind: 'cherry-pick', shas: selected }) },
      { type: 'separator' },
      { label: 'Copy SHAs', onClick: () => void actions.copyToClipboard(selected.join('\n'), 'SHAs copied') },
    ];
  }
  return [
    ...(isHead ? [{ label: 'Amend commit…', icon: 'pencil' as const, onClick: () => { actions.setView('changes'); void actions.setAmend(true); } }] : []),
    { label: 'Edit commit message…', onClick: () => openDialog({ kind: 'reword', commit }) },
    { label: 'Revert changes in commit', icon: 'undo', onClick: () => void actions.revertCommit(commit.sha) },
    { type: 'separator' },
    { label: 'Create branch from commit…', icon: 'branch', onClick: () => openDialog({ kind: 'new-branch', startPoint: commit.sha, startPointLabel: `${commit.shortSha} ${commit.summary}` }) },
    { label: 'Create tag…', icon: 'tag', onClick: () => openDialog({ kind: 'tag', sha: commit.sha }) },
    ...(tags.length ? [{ label: tags.length === 1 ? `Delete tag ${tags[0]}…` : 'Delete tag…', danger: true, onClick: () => void actions.deleteTag(tags[0]) }] : []),
    { label: 'Cherry-pick to branch…', icon: 'cherry', onClick: () => openDialog({ kind: 'cherry-pick', shas: [commit.sha] }) },
    { label: 'Checkout commit', onClick: () => void actions.checkoutCommit(commit.sha) },
    { label: 'Drop commit…', danger: true, onClick: () => openDialog({ kind: 'confirm', title: 'Drop commit?', message: `"${commit.summary}" will be removed from the branch history. Commits after it are rewritten.`, confirmLabel: 'Drop commit', danger: true, onConfirm: () => void actions.dropCommit(commit.sha) }) },
    { type: 'separator' },
    { label: 'Copy SHA', onClick: () => void actions.copyToClipboard(commit.sha, 'SHA copied') },
    ...(tags.length ? [{ label: 'Copy tag names', onClick: () => void actions.copyToClipboard(tags.join('\n'), 'Tags copied') }] : []),
    { label: 'View on GitHub', icon: 'external', onClick: () => repo?.github && void actions.openExternal(`${repo.github.url}/commit/${commit.sha}`), disabled: !repo?.github },
  ];
}

export function HistoryTab(): React.JSX.Element {
  const history = useAppStore((s) => s.history);
  const status = useAppStore((s) => s.status);
  const focused = useAppStore((s) => s.focused);
  const sentinel = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState<string | 'top' | null>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && history.hasMore && !history.loading) void actions.loadHistory(false);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [history.hasMore, history.loading]);

  const unpushedCount = status?.branch.upstream && !status.branch.upstreamGone && !history.search ? status.branch.ahead : status?.branch.upstream ? 0 : history.search ? 0 : null;

  const onDrop = (target: string | null) => {
    const moving = history.dragging;
    setDragOver(null);
    patchHistory({ dragging: null });
    if (!moving || (target && moving.includes(target))) return;
    void actions.reorderCommits(moving, target);
  };

  return (
    <>
      <div className="history-header">
        <FilterInput id="history-search" value={history.search} onChange={actions.setHistorySearch} placeholder="Search commits (message, author, SHA)" />
      </div>
      <div
        className="commit-list"
        onDragOver={(e) => {
          if (history.dragging) {
            e.preventDefault();
            if (!(e.target as HTMLElement).closest('.commit-row')) setDragOver('top');
          }
        }}
        onDrop={(e) => {
          if (!(e.target as HTMLElement).closest('.commit-row')) onDrop(null);
        }}
      >
        {history.loading && !history.commits.length ? (
          <div className="list-empty">
            <Spinner /> Loading history…
          </div>
        ) : null}
        {!history.loading && !history.commits.length ? <div className="list-empty">{history.search ? 'No commits match your search.' : status?.branch.unborn ? 'No commits yet.' : 'No history to show.'}</div> : null}
        {dragOver === 'top' && history.dragging ? <div style={{ height: 2, background: 'var(--accent)' }} /> : null}
        {history.commits.map((c, index) => {
          const selected = history.selectedShas.includes(c.sha);
          const unpushed = unpushedCount !== null && index < unpushedCount;
          const tags = c.refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
          const branchesRefs = c.refs.filter((r) => !r.startsWith('tag: ') && r !== 'HEAD');
          return (
            <div
              key={c.sha}
              className={`commit-row ${selected ? 'selected' : ''} ${selected && !focused ? 'inactive' : ''} ${dragOver === c.sha ? 'drag-over' : ''}`}
              onClick={(e) => actions.selectCommit(c.sha, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
              onContextMenu={(e) => {
                if (!history.selectedShas.includes(c.sha)) actions.selectCommit(c.sha);
                openContextMenu(e, commitMenu(c, store.get().history.selectedShas));
              }}
              draggable={!history.search}
              onDragStart={(e) => {
                const shas = history.selectedShas.includes(c.sha) ? history.selectedShas : [c.sha];
                patchHistory({ dragging: shas });
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', shas.join('\n'));
              }}
              onDragEnd={() => {
                patchHistory({ dragging: null });
                setDragOver(null);
              }}
              onDragOver={(e) => {
                if (history.dragging && !history.dragging.includes(c.sha)) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(c.sha);
                }
              }}
              onDragLeave={() => setDragOver((d) => (d === c.sha ? null : d))}
              onDrop={(e) => {
                e.stopPropagation();
                onDrop(c.sha);
              }}
              title={`${c.shortSha} · ${c.author.name} · ${new Date(c.author.date).toLocaleString()}`}
            >
              <Avatar email={c.author.email} name={c.author.name} size={28} />
              <span className="row-main">
                <span className="summary">{c.summary || <span className="muted">(no message)</span>}</span>
                <span className="meta">
                  <span className="truncate" style={{ flex: '0 1 auto' }}>{c.author.name}</span>
                  <span>·</span>
                  <RelativeTime date={c.committer.date} />
                  {c.isMerge ? <Icon name="merge" size={12} title="Merge commit" /> : null}
                  {tags.length || branchesRefs.length ? (
                    <span className="refs">
                      {tags.map((t) => (
                        <Badge key={t} tone="accent" outline title={`Tag ${t}`}>
                          <Icon name="tag" size={10} /> {t}
                        </Badge>
                      ))}
                      {branchesRefs.slice(0, 2).map((b) => (
                        <Badge key={b} outline title={b}>
                          {b}
                        </Badge>
                      ))}
                    </span>
                  ) : null}
                </span>
              </span>
              {unpushed ? <Icon name="arrow-up" className="unpushed" title="Not yet pushed" /> : null}
              {c.coAuthors.length ? <Icon name="person" className="muted" title={`Co-authored by ${c.coAuthors.map((a) => a.name).join(', ')}`} /> : null}
            </div>
          );
        })}
        <div ref={sentinel} className="load-more">
          {history.loading && history.commits.length ? <Spinner /> : history.hasMore ? <Button size="sm" variant="ghost" onClick={() => void actions.loadHistory(false)}>Load more</Button> : history.commits.length ? <span className="muted">End of history</span> : null}
        </div>
      </div>
    </>
  );
}

export function CommitDetailsPane(): React.JSX.Element {
  const history = useAppStore((s) => s.history);
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const [expanded, setExpanded] = useState(false);

  if (history.selectedShas.length > 1) {
    const selectedCommits = history.commits.filter((c) => history.selectedShas.includes(c.sha));
    const target = selectedCommits[selectedCommits.length - 1];
    return (
      <div className="multi-select-summary">
        <h3 style={{ margin: 0 }}>{history.selectedShas.length} commits selected</h3>
        <p className="muted" style={{ margin: 0 }}>Squash them into one commit, cherry-pick them onto another branch, or drag them to reorder.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon="squash" onClick={() => target && openDialog({ kind: 'squash', shas: history.selectedShas, targetSha: target.sha })}>Squash {history.selectedShas.length} commits…</Button>
          <Button icon="cherry" onClick={() => openDialog({ kind: 'cherry-pick', shas: history.selectedShas })}>Cherry-pick…</Button>
          <Button variant="ghost" onClick={() => void actions.copyToClipboard(history.selectedShas.join('\n'), 'SHAs copied')}>Copy SHAs</Button>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {selectedCommits.map((c) => (
            <li key={c.sha} className="truncate" style={{ maxWidth: 600 }}>
              <span className="mono muted">{c.shortSha}</span> {c.summary}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const details = history.details;
  if (!details) {
    return (
      <div className="empty-state">
        {history.detailsLoading ? <Spinner large /> : <Icon name="history" size={32} />}
        <p>{history.detailsLoading ? 'Loading commit…' : 'Select a commit to view its changes.'}</p>
      </div>
    );
  }
  const c = details.commit;
  const isHead = status?.branch.sha === c.sha;
  const tags = c.refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
  return (
    <div className="commit-details">
      <div className="commit-summary">
        <h3 className="selectable">{c.summary}</h3>
        <div className="meta-row">
          <Avatar email={c.author.email} name={c.author.name} size={18} />
          <span>{c.author.name}</span>
          {c.coAuthors.map((a) => (
            <span key={a.email} title={a.email}>
              , {a.name}
            </span>
          ))}
          <span>·</span>
          <RelativeTime date={c.author.date} prefix="committed " />
          <span>·</span>
          <button type="button" className="btn link mono" onClick={() => void actions.copyToClipboard(c.sha, 'SHA copied')} title="Copy full SHA">
            {c.shortSha} <Icon name="copy" size={12} />
          </button>
          {tags.map((t) => (
            <Badge key={t} tone="accent" outline>
              <Icon name="tag" size={10} /> {t}
            </Badge>
          ))}
          {details.pushed === false ? <Badge tone="attention">unpushed</Badge> : null}
          <span style={{ flex: 1 }} />
          {isHead && !status?.hasConflicts ? (
            <Button size="sm" variant="ghost" icon="pencil" onClick={() => { actions.setView('changes'); void actions.setAmend(true); }}>Amend</Button>
          ) : null}
          {isHead && details.pushed !== true && !status?.branch.unborn ? (
            <Button size="sm" variant="ghost" icon="undo" onClick={() => void actions.undoCommit()}>Undo</Button>
          ) : null}
          {repo?.github ? <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(`${repo.github!.url}/commit/${c.sha}`)}>GitHub</Button> : null}
        </div>
        {c.body ? (
          <pre className="description" style={expanded ? { maxHeight: 'none' } : undefined} onClick={() => setExpanded((v) => !v)}>
            {c.body}
          </pre>
        ) : null}
      </div>
      <div className="commit-body">
        <div className="commit-files">
          <div className="changes-header">
            <span className="count">{details.files.length} changed file{details.files.length === 1 ? '' : 's'}</span>
          </div>
          <div className="file-list">
            {details.files.map((f) => (
              <CommitFileRow
                key={f.path}
                file={f}
                selected={history.selectedFile === f.path}
                onSelect={() => actions.selectCommitFile(f.path)}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: 'Open in external editor', onClick: () => void actions.openInEditor(f.path), disabled: f.status === 'deleted' },
                    { label: isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => void actions.showInFolder(f.status === 'deleted' ? null : f.path) },
                    { label: 'Copy relative file path', onClick: () => void actions.copyToClipboard(f.path, 'Path copied') },
                    { label: 'View on GitHub', onClick: () => repo?.github && void actions.openExternal(`${repo.github.url}/blob/${c.sha}/${f.path}`), disabled: !repo?.github },
                  ])
                }
              />
            ))}
          </div>
        </div>
        <div id="commit-diff-slot" style={{ display: 'flex', flex: 1, minWidth: 0 }} />
      </div>
    </div>
  );
}
