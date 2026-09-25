import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Commit, CommitSignature, HistoryQuery, SignatureStatus } from '@shared/types';
import { isMac } from '../api';
import * as actions from '../state/actions';
import { historyFilterActive, historyReorderDisabled } from '../state/actions';
import { openDialog, patchHistory, setPopover, store, useAppStore } from '../state/store';
import { CommitFileRow } from './ChangesTab';
import { onListKeyDown } from '../lib/listKeys';
import { Avatar, Badge, Button, Callout, Checkbox, FilterInput, Icon, RelativeTime, Spinner, TextField, openContextMenu, type IconName, type MenuItem } from './ui';
import { useWindowedRows } from '../lib/windowing';

const COMMIT_ROW_ESTIMATES = { row: 60 };
const commitRowKind = (): string => 'row';

const SIGNATURE_BADGES: Partial<Record<SignatureStatus, { icon: IconName; className: string; label: (signer: string | null) => string }>> = {
  good: { icon: 'check-circle', className: 'sig-good', label: (signer) => `Good signature${signer ? ` from ${signer}` : ''}` },
  bad: { icon: 'x-circle', className: 'sig-bad', label: () => 'Bad signature' },
  revoked: { icon: 'x-circle', className: 'sig-bad', label: (signer) => `Signed with a revoked key${signer ? ` (${signer})` : ''}` },
  expired: { icon: 'alert', className: 'sig-warn', label: () => 'Signature has expired' },
  'expired-key': { icon: 'alert', className: 'sig-warn', label: (signer) => `Signed with an expired key${signer ? ` (${signer})` : ''}` },
  // Also what an SSH-signed commit shows when an allowed-signers file is configured but does not
  // list this signer (git can check the signature cryptographically but not the identity).
  untrusted: { icon: 'lock', className: 'sig-unknown', label: (signer) => `Good signature from an unrecognized or untrusted key${signer ? ` (${signer})` : ''}. For SSH signatures, add the signer to the allowed-signers file in Options → Git.` },
  'unknown-key': { icon: 'lock', className: 'sig-unknown', label: (signer) => (signer ? `Signed by ${signer}; the key is not available to verify it.` : 'Signature from an unrecognized key.') },
};

function SignatureBadge({ signature }: { signature: CommitSignature | null }): React.JSX.Element | null {
  if (!signature || signature.status === 'none') return null;
  const badge = SIGNATURE_BADGES[signature.status];
  if (!badge) return null;
  return <Icon name={badge.icon} size={12} className={badge.className} title={badge.label(signature.signer)} />;
}

function commitMenu(commit: Commit, selected: string[]): MenuItem[] {
  const s = store.get();
  const repo = s.currentRepo;
  const isHead = s.status?.branch.sha === commit.sha;
  const tags = commit.refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
  const aiEnabled = (s.settings?.ai.provider ?? 'disabled') !== 'disabled';
  if (selected.length > 1 && selected.includes(commit.sha)) {
    const target = s.history.commits.filter((c) => selected.includes(c.sha)).pop()!;
    const tidyReason = aiEnabled ? actions.tidyBranchDisabledReason(selected) : 'AI features are turned off';
    return [
      { label: `Squash ${selected.length} commits…`, icon: 'squash', onClick: () => openDialog({ kind: 'squash', shas: selected, targetSha: target.sha }) },
      { label: `Cherry-pick ${selected.length} commits…`, icon: 'cherry', onClick: () => openDialog({ kind: 'cherry-pick', shas: selected }) },
      ...(aiEnabled ? [{ label: 'Tidy Up with AI…', icon: 'sparkle' as const, disabled: !!tidyReason, title: tidyReason ?? undefined, onClick: () => actions.tidyBranch(selected) }] : []),
      { type: 'separator' },
      { label: 'Copy SHAs', onClick: () => void actions.copyToClipboard(selected.join('\n'), 'SHAs copied') },
    ];
  }
  return [
    ...(aiEnabled ? [{ label: 'Explain commit', icon: 'sparkle' as const, onClick: () => actions.explainCommit(commit.sha) }, { type: 'separator' as const }] : []),
    ...(isHead ? [{ label: 'Amend commit…', icon: 'pencil' as const, onClick: () => { actions.setView('changes'); void actions.setAmend(true); } }] : []),
    { label: 'Edit commit message…', onClick: () => openDialog({ kind: 'reword', commit }) },
    { label: 'Revert changes in commit', icon: 'undo', onClick: () => void actions.revertCommit(commit.sha) },
    { type: 'separator' },
    { label: 'Create branch from commit…', icon: 'branch', onClick: () => openDialog({ kind: 'new-branch', startPoint: commit.sha, startPointLabel: `${commit.shortSha} ${commit.summary}` }) },
    { label: 'Create tag…', icon: 'tag', onClick: () => openDialog({ kind: 'tag', sha: commit.sha }) },
    ...(tags.length ? [{ label: tags.length === 1 ? `Delete tag ${tags[0]}…` : 'Delete tag…', danger: true, onClick: () => void actions.deleteTag(tags[0]) }] : []),
    ...(tags.length ? [{ label: `Release notes since ${tags[0]}…`, icon: 'tag' as const, onClick: () => actions.openReleaseNotes(tags[0]) }] : []),
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
  const popover = useAppStore((s) => s.popover);
  const verifySignatures = useAppStore((s) => s.settings?.historyVerifySignatures ?? false);
  const sentinel = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState<string | 'top' | null>(null);
  const [listEl, setListEl] = useState<HTMLElement | null>(null);
  const [historySearchFocused, setHistorySearchFocused] = useState(false);
  const [filterCheatSheetOpen, setFilterCheatSheetOpen] = useState(true);
  const [filterCheatSheetDismissed, setFilterCheatSheetDismissed] = useState(false);
  const commitKey = useCallback((i: number) => history.commits[i].sha, [history.commits]);
  const win = useWindowedRows(listEl, { count: history.commits.length, kindOf: commitRowKind, keyOf: commitKey, estimates: COMMIT_ROW_ESTIMATES, resetKey: history.path ?? '' });
  const filterActive = historyFilterActive(history);
  const reorderDisabled = historyReorderDisabled(history);

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

  const onDrop = useCallback((target: string | null) => {
    const moving = store.get().history.dragging;
    setDragOver(null);
    patchHistory({ dragging: null });
    if (!moving || (target && moving.includes(target))) return;
    void actions.reorderCommits(moving, target);
  }, []);
  const onRowDragOver = useCallback((sha: string, e: React.DragEvent) => {
    const dragging = store.get().history.dragging;
    if (dragging && !dragging.includes(sha)) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(sha);
    }
  }, []);
  const onRowDragLeave = useCallback((sha: string) => setDragOver((d) => (d === sha ? null : d)), []);
  const onRowDragEnd = useCallback(() => {
    patchHistory({ dragging: null });
    setDragOver(null);
  }, []);

  const rows: React.ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) {
    const c = history.commits[i];
    rows.push(<CommitRow key={c.sha} rowRef={win.rowRef(i)} commit={c} selected={history.selectedShas.includes(c.sha)} inactive={!focused} unpushed={unpushedCount !== null && i < unpushedCount} dragOver={dragOver === c.sha} draggable={!reorderDisabled} verifySignatures={verifySignatures} onDragOver={onRowDragOver} onDragLeave={onRowDragLeave} onDragEnd={onRowDragEnd} onDrop={onDrop} />);
  }

  return (
    <>
      {history.path ? (
        <div className="history-path-chip">
          <Icon name="history" size={12} />
          <span className="mono truncate" title={history.path}>{history.path}</span>
          <Button size="sm" variant="ghost" iconOnly icon="x" title="Show full branch history" aria-label="Show full branch history" onClick={() => actions.clearFileHistory()} />
        </div>
      ) : null}
      <div className="history-header" style={{ position: 'relative' }}>
        <div
          className="history-search-shell"
          style={{ flex: 1, minWidth: 0 }}
          onFocus={() => {
            setHistorySearchFocused(true);
            if (filterCheatSheetDismissed) {
              setFilterCheatSheetDismissed(false);
              setFilterCheatSheetOpen(true);
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHistorySearchFocused(false);
          }}
        >
          <FilterInput id="history-search" value={history.search} onChange={actions.setHistorySearch} placeholder="Search commits, or content:/regex:/path:/author:/after:/before:/all:" />
          {historySearchFocused ? (
            filterCheatSheetDismissed ? (
              <Button size="sm" variant="ghost" icon="chevron-down" onClick={() => { setFilterCheatSheetDismissed(false); setFilterCheatSheetOpen(true); }}>Show filter syntax</Button>
            ) : (
              <Callout tone="neutral" icon="filter">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ flex: 1 }}>Filter syntax</strong>
                  <Button size="sm" variant="ghost" iconOnly icon={filterCheatSheetOpen ? 'chevron-down' : 'chevron-right'} title={filterCheatSheetOpen ? 'Collapse filter syntax' : 'Expand filter syntax'} aria-label={filterCheatSheetOpen ? 'Collapse filter syntax' : 'Expand filter syntax'} onClick={() => setFilterCheatSheetOpen((open) => !open)} />
                  <Button size="sm" variant="ghost" iconOnly icon="x" title="Dismiss filter syntax" aria-label="Dismiss filter syntax" onClick={() => { setFilterCheatSheetDismissed(true); setFilterCheatSheetOpen(false); }} />
                </div>
                {filterCheatSheetOpen ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px', marginTop: 6, fontSize: 11 }}>
                    <code>content:</code><span>search added and removed lines</span>
                    <code>regex:</code><span>match changed lines with a POSIX ERE</span>
                    <code>path:</code><span>limit matches to a file or glob</span>
                    <code>author:</code><span>match an author name or email</span>
                    <code>after:</code><span>commits on or after a date</span>
                    <code>before:</code><span>commits on or before a date</span>
                  </div>
                ) : null}
              </Callout>
            )
          ) : null}
        </div>
        <Button
          className="history-filter-toggle"
          size="sm"
          variant={popover === 'history-filter' ? 'accent' : 'ghost'}
          iconOnly
          aria-label="Filter history…"
          icon="filter"
          title="Filter history…"
          onClick={() => setPopover('history-filter')}
        />
        {popover === 'history-filter' ? <HistoryFilterPopover /> : null}
      </div>
      {history.queryError ? (
        <div className="history-query-error">
          <Icon name="alert" size={12} /> {history.queryError}
        </div>
      ) : filterActive ? (
        <div className="history-match-bar">
          <span>
            {history.commits.length}
            {history.hasMore ? '+' : ''} {history.commits.length === 1 && !history.hasMore ? 'commit' : 'commits'} match
          </span>
          {history.slowSearch && history.loading ? <span className="muted">Still searching… try narrowing with a path: filter.</span> : null}
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={() => actions.clearHistoryFilter()}>Clear</Button>
        </div>
      ) : null}
      <div
        ref={setListEl}
        className="commit-list"
        role="listbox"
        aria-multiselectable
        aria-label="Commits"
        onKeyDown={onListKeyDown}
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
        {!history.loading && !history.commits.length ? (
          <div className="list-empty">
            {history.error ? (
              <>
                {history.error}
                <div>
                  <Button size="sm" onClick={() => void actions.loadHistory(true)}>Retry</Button>
                </div>
              </>
            ) : filterActive ? (
              'No commits match your search.'
            ) : status?.branch.unborn ? (
              'No commits yet.'
            ) : (
              'No history to show.'
            )}
          </div>
        ) : null}
        {dragOver === 'top' && history.dragging ? <div style={{ height: 2, background: 'var(--accent)' }} /> : null}
        {win.top > 0 ? <div style={{ height: win.top }} /> : null}
        {rows}
        {win.bottom > 0 ? <div style={{ height: win.bottom }} /> : null}
        <div ref={sentinel} className="load-more">
          {history.loading && history.commits.length ? <Spinner /> : history.hasMore ? <Button size="sm" variant="ghost" onClick={() => void actions.loadHistory(false)}>Load more</Button> : history.commits.length ? <span className="muted">End of history</span> : null}
        </div>
      </div>
    </>
  );
}

const CommitRow = memo(function CommitRow({ commit: c, selected, inactive, unpushed, dragOver, draggable, verifySignatures, rowRef, onDragOver, onDragLeave, onDragEnd, onDrop }: { commit: Commit; selected: boolean; inactive: boolean; unpushed: boolean; dragOver: boolean; draggable: boolean; verifySignatures: boolean; rowRef: (el: HTMLElement | null) => void; onDragOver: (sha: string, e: React.DragEvent) => void; onDragLeave: (sha: string) => void; onDragEnd: () => void; onDrop: (sha: string) => void }): React.JSX.Element {
  const tags = c.refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
  const branchesRefs = c.refs.filter((r) => !r.startsWith('tag: ') && r !== 'HEAD');
  return (
    <div
      ref={rowRef}
      tabIndex={0}
      role="option"
      aria-selected={selected}
      className={`commit-row ${selected ? 'selected' : ''} ${selected && inactive ? 'inactive' : ''} ${dragOver ? 'drag-over' : ''}`}
      onClick={(e) => actions.selectCommit(c.sha, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
      onContextMenu={(e) => {
        if (!store.get().history.selectedShas.includes(c.sha)) actions.selectCommit(c.sha);
        openContextMenu(e, commitMenu(c, store.get().history.selectedShas));
      }}
      draggable={draggable}
      onDragStart={(e) => {
        const current = store.get().history.selectedShas;
        const shas = current.includes(c.sha) ? current : [c.sha];
        patchHistory({ dragging: shas });
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', shas.join('\n'));
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(c.sha, e)}
      onDragLeave={() => onDragLeave(c.sha)}
      onDrop={(e) => {
        e.stopPropagation();
        onDrop(c.sha);
      }}
      // The full date is formatted only when the tooltip is about to show: toLocaleString per row per render is measurable at 2k rows.
      onMouseEnter={(e) => {
        if (!e.currentTarget.title) e.currentTarget.title = `${c.shortSha} · ${c.author.name} · ${new Date(c.author.date).toLocaleString()}`;
      }}
    >
      <Avatar email={c.author.email} name={c.author.name} size={24} />
      <span className="row-main">
        <span className="commit-primary">
          <span className="summary">{c.summary || <span className="muted">(no message)</span>}</span>
          {tags.length || branchesRefs.length ? (
            <span className="refs">
              {tags.map((t) => (
                <Badge key={t} tone="accent" outline title={'Tag ' + t}>
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
        <span className="commit-secondary">
          <span className="truncate" style={{ flex: '0 1 auto' }}>{c.author.name}</span>
          <span>·</span>
          <RelativeTime date={c.committer.date} />
        </span>
      </span>
      <span className="commit-row-tail">
        {unpushed ? <Icon name="arrow-up" className="unpushed" title="Not yet pushed" /> : null}
        <span className="commit-row-deferred" aria-label="Additional commit metadata">
          {c.isMerge ? <Icon name="merge" size={12} title="Merge commit" /> : null}
          {c.coAuthors.length ? <Icon name="person" className="muted" title={'Co-authored by ' + c.coAuthors.map((a) => a.name).join(', ')} /> : null}
          {verifySignatures ? <SignatureBadge signature={c.signature} /> : null}
        </span>
        {draggable ? (
          <span className="commit-drag-handle" role="img" aria-label="Drag to reorder commits" title="Drag to reorder commits">
            <Icon name="rows" size={14} />
          </span>
        ) : null}
      </span>
    </div>
  );
});

/** Form-control equivalent of the search box's `key:value` syntax; two-way synced through `history.query` (see setHistoryQuery). */
function HistoryFilterPopover(): React.JSX.Element {
  const query = useAppStore((s) => s.history.query);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.popover') || target.closest('.history-filter-toggle') || target.closest('.context-menu')) return;
      setPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  const update = (patch: Partial<HistoryQuery>) => actions.setHistoryQuery({ ...store.get().history.query, ...patch });
  return (
    <div className="popover history-filter-popover" style={{ top: 40, right: 0, left: 'auto' }}>
      <div className="popover-header">
        <strong>Filter history</strong>
      </div>
      <div className="history-filter-body">
        <TextField label="Content contains (added or removed)" placeholder="e.g. computeTotal" value={query.content ?? ''} onChange={(e) => update({ content: e.target.value || null })} />
        <TextField label="Diff matches regex" hint="POSIX ERE; matches lines that changed, not just added/removed" placeholder="e.g. ^import" value={query.diffRegex ?? ''} onChange={(e) => update({ diffRegex: e.target.value || null })} />
        <TextField label="Path" placeholder="src/**/*.ts" value={query.paths[0] ?? ''} onChange={(e) => update({ paths: e.target.value ? [e.target.value] : [] })} />
        <TextField label="Author" placeholder="name or email" value={query.author ?? ''} onChange={(e) => update({ author: e.target.value || null })} />
        <div style={{ display: 'flex', gap: 8 }}>
          <TextField label="After" type="date" value={query.after ?? ''} onChange={(e) => update({ after: e.target.value || null })} />
          <TextField label="Before" type="date" value={query.before ?? ''} onChange={(e) => update({ before: e.target.value || null })} />
        </div>
        <Checkbox checked={query.allRefs} onChange={(v) => update({ allRefs: v })} label="Search every branch, tag and remote" />
      </div>
      <div className="popover-footer">
        <Button size="sm" variant="ghost" onClick={() => actions.clearHistoryFilter()}>Clear all</Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => setPopover(null)}>Done</Button>
      </div>
    </div>
  );
}

export function CommitDetailsPane(): React.JSX.Element {
  const history = useAppStore((s) => s.history);
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const verifySignatures = useAppStore((s) => s.settings?.historyVerifySignatures ?? false);
  const aiEnabled = useAppStore((s) => (s.settings?.ai.provider ?? 'disabled') !== 'disabled');
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
        {history.detailsLoading ? <Spinner large /> : <Icon name={history.detailsError ? 'alert' : 'history'} size={32} />}
        <p>{history.detailsLoading ? 'Loading commit…' : history.detailsError ?? 'Select a commit to view its changes.'}</p>
        {history.detailsError ? (
          <Button size="sm" onClick={() => void actions.loadCommitDetails(history.selectedShas[0])}>Retry</Button>
        ) : null}
      </div>
    );
  }
  const c = details.commit;
  const visibleFiles = history.matchingFiles ? details.files.filter((f) => history.matchingFiles!.includes(f.path)) : details.files;
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
          <Button variant="link" className="mono" onClick={() => void actions.copyToClipboard(c.sha, 'SHA copied')} title="Copy full SHA">
            {c.shortSha} <Icon name="copy" size={12} />
          </Button>
          {tags.map((t) => (
            <Badge key={t} tone="accent" outline>
              <Icon name="tag" size={10} /> {t}
            </Badge>
          ))}
          {details.pushed === false ? <Badge tone="attention">unpushed</Badge> : null}
          {verifySignatures && c.signature && c.signature.status !== 'none' ? (
            <span title={SIGNATURE_BADGES[c.signature.status]?.label(c.signature.signer)}>
              <SignatureBadge signature={c.signature} /> {c.signature.signer ?? 'unknown signer'}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {aiEnabled ? (
            <Button size="sm" variant="ghost" icon="sparkle" onClick={() => actions.explainCommit(c.sha)}>Explain</Button>
          ) : null}
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
            <span className="count">
              {visibleFiles.length} {history.matchingFiles ? 'matching' : 'changed'} file{visibleFiles.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="file-list" role="listbox" aria-label="Changed files" data-phone-next="file" onKeyDown={onListKeyDown}>
            {visibleFiles.map((f) => (
              <CommitFileRow
                key={f.path}
                file={f}
                selected={history.selectedFile === f.path}
                onSelect={() => actions.selectCommitFile(f.path)}
                onContextMenu={(e) => {
                  const unavailable = f.binary || f.status === 'deleted';
                  openContextMenu(e, [
                    { label: 'Open in external editor', onClick: () => void actions.openInEditor(f.path), disabled: f.status === 'deleted' },
                    { label: isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => void actions.showInFolder(f.status === 'deleted' ? null : f.path) },
                    { label: 'Copy relative file path', onClick: () => void actions.copyToClipboard(f.path, 'Path copied') },
                    { type: 'separator' },
                    { label: 'Blame this file', onClick: () => { actions.selectCommitFile(f.path); actions.toggleBlame(); }, disabled: unavailable },
                    { label: 'File history…', onClick: () => actions.openFileHistory(f.path) },
                    { label: 'View file at this commit', onClick: () => actions.openFileAtCommit(f.path, c.sha), disabled: unavailable },
                    { label: 'Restore this version…', onClick: () => actions.requestRestoreFile(f.path, c.sha), disabled: unavailable },
                    { type: 'separator' },
                    { label: 'View on GitHub', onClick: () => repo?.github && void actions.openExternal(`${repo.github.url}/blob/${c.sha}/${f.path}`), disabled: !repo?.github },
                  ]);
                }}
              />
            ))}
          </div>
        </div>
        <div id="commit-diff-slot" style={{ display: 'flex', flex: 1, minWidth: 0 }} />
      </div>
    </div>
  );
}
