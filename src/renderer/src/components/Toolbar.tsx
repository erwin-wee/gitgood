import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Branch, PrTriage, PullRequest, RepositoryInfo, TriageNextAction, TriageState } from '@shared/types';
import { compareStrings, formatRelativeTime } from '@shared/util';
import { invoke, isMac } from '../api';
import * as actions from '../state/actions';
import { openDialog, setPopover, store, useAppStore } from '../state/store';
import { Avatar, Badge, Button, FilterInput, Icon, RelativeTime, Spinner, openContextMenu, useFilter, type MenuItem } from './ui';

export function Toolbar(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const popover = useAppStore((s) => s.popover);
  const progress = useAppStore((s) => s.progress);
  const operation = useAppStore((s) => s.operation);
  const remotes = useAppStore((s) => s.remotes);
  const settings = useAppStore((s) => s.settings);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const currentPr = useAppStore((s) => s.prs.current);
  const prsList = useAppStore((s) => s.prs.list);
  const triageCache = useAppStore((s) => s.triage.byNumber);
  const ghLogin = useAppStore((s) => s.tools?.ghAccount?.login ?? null);
  const triageEnabled = settings?.ai.provider !== 'disabled' && !!repo?.github;
  const waitingOnYouCount = useMemo(() => (triageEnabled ? actions.waitingOnYouPrs(prsList, triageCache, ghLogin).length : 0), [triageEnabled, prsList, triageCache, ghLogin]);

  const activeProgress = Object.values(progress).find((p) => !p.repoPath || p.repoPath === repo?.path) ?? null;
  const branch = status?.branch ?? null;

  let syncTitle = 'Fetch origin';
  let syncValue: React.ReactNode = status?.lastFetched ? `Last fetched ${formatRelativeTime(status.lastFetched)}` : 'Never fetched';
  let syncIcon: 'sync' | 'arrow-up' | 'arrow-down' | 'upload' = 'sync';
  let syncAction: () => void = () => void actions.fetchRemote();
  let disabled = !repo || !!operation;
  const hasRemote = remotes.length > 0;
  if (repo && status) {
    if (!hasRemote) {
      syncTitle = 'Publish repository';
      syncValue = 'Publish this repository to GitHub';
      syncIcon = 'upload';
      syncAction = () => openDialog({ kind: 'publish' });
    } else if (branch?.detached) {
      syncTitle = 'Fetch origin';
    } else if (branch && (!branch.upstream || branch.upstreamGone)) {
      syncTitle = 'Publish branch';
      syncValue = branch.upstreamGone ? 'Upstream branch was deleted; publish again' : 'Publish this branch to origin';
      syncIcon = 'upload';
      syncAction = () => void actions.pushWithErrorHandling();
      if (branch.unborn) {
        syncTitle = 'Publish repository';
        syncValue = 'Commit first, then publish';
        disabled = true;
      }
    } else if (branch && branch.behind > 0) {
      syncTitle = 'Pull origin';
      syncValue = (
        <span>
          {status.lastFetched ? `Last fetched ${formatRelativeTime(status.lastFetched)}` : 'Pull latest changes'}
          <span className="badges">
            <Badge>
              <Icon name="arrow-down" size={12} /> {branch.behind}
            </Badge>
            {branch.ahead > 0 ? (
              <Badge>
                <Icon name="arrow-up" size={12} /> {branch.ahead}
              </Badge>
            ) : null}
          </span>
        </span>
      );
      syncIcon = 'arrow-down';
      syncAction = () => void actions.pull();
    } else if (branch && branch.ahead > 0) {
      syncTitle = 'Push origin';
      syncValue = (
        <span>
          {status.lastFetched ? `Last fetched ${formatRelativeTime(status.lastFetched)}` : 'Push local commits'}
          <span className="badges">
            <Badge>
              <Icon name="arrow-up" size={12} /> {branch.ahead}
            </Badge>
          </span>
        </span>
      );
      syncIcon = 'arrow-up';
      syncAction = () => void actions.pushWithErrorHandling();
    }
  }
  if (activeProgress) {
    syncTitle = activeProgress.title;
    syncValue = activeProgress.description;
  } else if (operation) {
    syncTitle = operation;
    syncValue = 'Working…';
  }

  const syncLabel = typeof syncValue === 'string' ? `${syncTitle}: ${syncValue}` : syncTitle;
  const branchLabel = !repo ? '—' : !status ? 'Loading…' : status.operation.kind === 'rebase' ? `Rebasing ${status.operation.headName ?? ''}` : branch?.detached ? 'Detached HEAD' : branch?.unborn ? `${branch.name ?? 'main'} (no commits)` : branch?.name ?? '—';

  return (
    <div className={`toolbar ${isMac ? 'mac' : ''}`}>
      <Button className={`toolbar-button repo ${popover === 'repos' ? 'open' : ''}`} onClick={() => setPopover('repos')} title="Current repository (Ctrl+T)" aria-label={`Current repository: ${repo ? repo.alias ?? repo.name : 'No repository'}`}>
        <Icon name="repo" className="icon" />
        <span className="labels">
          <span className="title">Current repository</span>
          <span className="value truncate">{repo ? repo.alias ?? repo.name : 'No repository'}</span>
        </span>
        <Icon name="chevron-down" className="chevron" />
      </Button>
      <Button className={`toolbar-button branch ${popover === 'branches' ? 'open' : ''}`} onClick={() => repo && setPopover('branches')} disabled={!repo} title={waitingOnYouCount ? `Current branch — ${waitingOnYouCount} pull request${waitingOnYouCount === 1 ? '' : 's'} waiting on you (Ctrl+B)` : 'Current branch (Ctrl+B)'} aria-label={`Current branch: ${branchLabel}`}>
        <Icon name={currentPr ? 'pull-request' : 'branch'} className="icon" />
        <span className="labels">
          <span className="title">{currentPr ? `Pull request #${currentPr.number}` : 'Current branch'}</span>
          <span className="value truncate">{branchLabel}</span>
        </span>
        {waitingOnYouCount ? <Badge tone="accent">{waitingOnYouCount}</Badge> : null}
        <Icon name="chevron-down" className="chevron" />
      </Button>
      <Button className="toolbar-button sync" onClick={syncAction} disabled={disabled || !!activeProgress} title={`${syncLabel} (Ctrl+Shift+T fetch, Ctrl+P push, Ctrl+Shift+P pull)`} aria-label={syncLabel}>
        {activeProgress || operation ? <Spinner /> : <Icon name={syncIcon} className="icon" />}
        <span className="labels">
          <span className="title">{syncTitle}</span>
          <span className="value truncate">{syncValue}</span>
        </span>
        {activeProgress ? <span className="toolbar-progress" style={{ width: `${Math.round((activeProgress.percent ?? 0.1) * 100)}%` }} /> : null}
      </Button>
      {activeProgress && activeProgress.kind === 'generic' ? (
        <Button size="sm" variant="ghost" iconOnly icon="x" title="Cancel" aria-label="Cancel operation" onClick={() => void invoke('app.operations.cancel', activeProgress.id)} />
      ) : null}
      <span className="toolbar-spacer" />
      <div className="toolbar-right">
        {aiBusy ? (
          <span className="ai-status">
            <Spinner /> AI resolving…
          </span>
        ) : null}
        {settings?.ai.provider !== 'disabled' && repo && status?.hasConflicts ? (
          <Button variant="ghost" size="sm" icon="sparkle" className="sparkle" onClick={() => openDialog({ kind: 'conflicts' })} title="Resolve conflicts with AI">
            Resolve conflicts
          </Button>
        ) : null}
        <Button variant="ghost" iconOnly icon="info" title="Help" aria-label="Help" onClick={() => store.set({ helpOpen: true })} />
        <InboxBell />
        <Button variant="ghost" iconOnly icon="gear" title="Options (Ctrl+,)" aria-label="Options" onClick={() => openDialog({ kind: 'settings' })} />
      </div>
      {popover === 'repos' ? <RepositoryPopover /> : null}
      {popover === 'branches' && repo ? <BranchPopover /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repository popover
// ---------------------------------------------------------------------------

function usePopoverClose(): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.popover') || target.closest('.toolbar-button') || target.closest('.context-menu')) return;
      store.set({ popover: null });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.set({ popover: null });
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

const repoKeys = (r: RepositoryInfo) => [r.name, r.alias ?? '', r.github?.owner ?? '', r.path];

function RepositoryPopover(): React.JSX.Element {
  usePopoverClose();
  const repos = useAppStore((s) => s.repos);
  const current = useAppStore((s) => s.currentRepo);
  const settings = useAppStore((s) => s.settings);
  const work = useAppStore((s) => s.work);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const filtered = useFilter(repos, query, repoKeys);

  useEffect(() => {
    if (settings?.repositoryIndicators && repos.length <= 25) void invoke('repos.refreshIndicators').catch(() => undefined);
    if (settings?.showUnpushedWorkIndicator && repos.length <= 25) void actions.loadWork();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workById = useMemo(() => new Map(work.map((w) => [w.repoId, w])), [work]);
  const hasUnpushedWork = (r: RepositoryInfo): boolean => {
    const w = workById.get(r.id);
    return !!w && (w.aheadBranches.length > 0 || w.unpublishedBranches.length > 0 || w.stashCount > 0);
  };

  const matchedIds = useMemo(() => new Set(filtered.map((r) => r.id)), [filtered]);
  const childrenOf = (id: string) => repos.filter((r) => (r.worktreeOf === id || r.parentRepoId === id) && (!query.trim() || matchedIds.has(r.id)));
  const topLevel = useMemo(() => repos.filter((r) => !r.worktreeOf && !r.parentRepoId && (matchedIds.has(r.id) || childrenOf(r.id).length > 0)), [repos, matchedIds, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const github: Record<string, RepositoryInfo[]> = {};
    const other: RepositoryInfo[] = [];
    for (const r of topLevel) {
      if (r.github) (github[r.github.owner] ??= []).push(r);
      else other.push(r);
    }
    const ownerNames = Object.keys(github).sort(compareStrings);
    return { ownerNames, github, other };
  }, [topLevel]);

  const contextMenu = (e: React.MouseEvent, repo: RepositoryInfo) => {
    const items: MenuItem[] = [
      { label: 'Open in external editor', onClick: () => void actions.openRepository(repo).then(() => actions.openInEditor()), disabled: repo.missing },
      { label: 'Open in terminal', onClick: () => void actions.openRepository(repo).then(() => actions.openInShell()), disabled: repo.missing },
      { label: 'Show in folder', onClick: () => void actions.openRepository(repo).then(() => actions.showInFolder()), disabled: repo.missing },
      { type: 'separator' },
      { label: 'Copy repository path', onClick: () => void actions.copyToClipboard(repo.path, 'Path copied') },
      { label: repo.alias ? 'Change alias…' : 'Create alias…', onClick: () => { store.set({ popover: null }); void actions.openRepository(repo).then(() => openDialog({ kind: 'repo-settings', tab: 'alias' })); } },
      { type: 'separator' },
      repo.worktreeOf
        ? { label: 'Manage worktrees…', onClick: () => { store.set({ popover: null }); void actions.openRepository(repos.find((r) => r.id === repo.worktreeOf) ?? repo).then(() => openDialog({ kind: 'worktrees' })); } }
        : { label: 'Worktrees…', onClick: () => { store.set({ popover: null }); void actions.openRepository(repo).then(() => openDialog({ kind: 'worktrees' })); } },
      { type: 'separator' },
      { label: 'Remove…', danger: true, disabled: !!repo.worktreeOf, onClick: () => openDialog({ kind: 'remove-repo', repo }) },
    ];
    openContextMenu(e, items);
  };

  const row = (r: RepositoryInfo, nested = false) => (
    <div key={r.id} className={`list-row ${current?.id === r.id ? 'selected' : ''} ${r.missing ? 'disabled' : ''}`} style={nested ? { paddingLeft: 28 } : undefined} onClick={() => { store.set({ popover: null }); void actions.openRepository(r); }} onContextMenu={(e) => contextMenu(e, r)} title={r.path}>
      <Icon name={r.parentRepoId ? 'folder' : nested ? 'worktree' : r.github ? 'github' : 'repo'} />
      <span className="row-main">
        <span className="truncate">
          {r.alias ?? r.name}
          {r.alias ? <span className="muted"> ({r.name})</span> : null}
          {r.origin === 'watched' ? <Icon name="search" size={11} className="muted" title="Found in a watched folder" /> : null}
        </span>
        {r.missing ? <span className="row-sub">Repository not found on disk</span> : null}
      </span>
      {settings?.repositoryIndicators && r.indicator ? (
        <span className="row-meta" style={{ display: 'inline-flex', gap: 4 }}>
          {r.indicator.hasChanges ? <Icon name="dot-fill" size={12} title="Uncommitted changes" /> : null}
          {r.indicator.ahead > 0 ? <span title={`${r.indicator.ahead} ahead`}><Icon name="arrow-up" size={12} />{r.indicator.ahead}</span> : null}
          {r.indicator.behind > 0 ? <span title={`${r.indicator.behind} behind`}><Icon name="arrow-down" size={12} />{r.indicator.behind}</span> : null}
        </span>
      ) : null}
      {settings?.showUnpushedWorkIndicator && hasUnpushedWork(r) ? <Icon name="dot-fill" size={8} className="warning-dot" title="This repository has unpushed work" /> : null}
    </div>
  );

  const rowWithChildren = (r: RepositoryInfo) => (
    <React.Fragment key={r.id}>
      {row(r)}
      {childrenOf(r.id).map((c) => row(c, true))}
    </React.Fragment>
  );

  return (
    <div className="popover" style={{ left: isMac ? 76 : 0 }}>
      <div className="popover-header">
        <FilterInput value={query} onChange={setQuery} placeholder="Filter repositories" autoFocus />
        <div style={{ position: 'relative' }}>
          <Button icon="plus" onClick={() => setAddOpen((v) => !v)}>
            Add <Icon name="chevron-down" size={12} />
          </Button>
          {addOpen ? (
            <div className="context-menu" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 5 }}>
              <button type="button" className="item" onClick={() => { store.set({ popover: null }); openDialog({ kind: 'clone' }); }}>Clone repository… <span className="shortcut">Ctrl+Shift+O</span></button>
              <button type="button" className="item" onClick={() => { store.set({ popover: null }); openDialog({ kind: 'new-repo' }); }}>Create new repository… <span className="shortcut">Ctrl+N</span></button>
              <button type="button" className="item" onClick={() => { store.set({ popover: null }); openDialog({ kind: 'add-repo' }); }}>Add existing repository… <span className="shortcut">Ctrl+O</span></button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="popover-list">
        {topLevel.length === 0 ? <div className="list-empty">{repos.length === 0 ? 'No repositories yet. Add or clone one to get started.' : 'No matching repositories.'}</div> : null}
        {groups.ownerNames.map((owner) => (
          <React.Fragment key={owner}>
            <div className="list-group-header">{owner}</div>
            {groups.github[owner].sort((a, b) => compareStrings(a.alias ?? a.name, b.alias ?? b.name)).map(rowWithChildren)}
          </React.Fragment>
        ))}
        {groups.other.length ? (
          <>
            <div className="list-group-header">Other</div>
            {groups.other.map(rowWithChildren)}
          </>
        ) : null}
      </div>
      <div className="popover-footer">
        <span className="muted">{repos.length} {repos.length === 1 ? 'repository' : 'repositories'}</span>
        <Button size="sm" variant="ghost" icon="sync" onClick={() => void invoke('repos.refreshIndicators')} title="Refresh ahead/behind indicators">Refresh</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch popover
// ---------------------------------------------------------------------------

const branchKeys = (b: Branch) => [b.name, b.lastCommitSubject, b.lastCommitAuthor];

function BranchPopover(): React.JSX.Element {
  usePopoverClose();
  const repo = useAppStore((s) => s.currentRepo);
  const branches = useAppStore((s) => s.branches);
  const defaultBranch = useAppStore((s) => s.defaultBranch);
  const prs = useAppStore((s) => s.prs);
  const [tab, setTab] = useState<'branches' | 'prs'>('branches');
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab === 'prs') {
      void actions.loadPullRequests();
      void actions.loadTriageCache();
    }
  }, [tab]);

  const locals = useMemo(() => branches.filter((b) => b.kind === 'local'), [branches]);
  const remoteOnly = useMemo(() => {
    const localUpstreams = new Set(locals.map((l) => l.upstream).filter(Boolean));
    const localNames = new Set(locals.map((l) => l.name));
    return branches.filter((b) => b.kind === 'remote' && !localUpstreams.has(b.name) && !localNames.has(b.name.slice(b.name.indexOf('/') + 1)));
  }, [branches, locals]);
  const filteredLocals = useFilter(locals, query, branchKeys);
  const filteredRemote = useFilter(remoteOnly, query, branchKeys);

  const current = locals.find((b) => b.isCurrent) ?? null;
  const def = filteredLocals.find((b) => b.name === defaultBranch) ?? null;
  const recent = filteredLocals.filter((b) => b.name !== defaultBranch && !b.isCurrent).sort((a, b) => new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime()).slice(0, 5);
  const recentNames = new Set(recent.map((b) => b.name));
  const others = filteredLocals.filter((b) => b.name !== defaultBranch && !recentNames.has(b.name)).sort((a, b) => compareStrings(a.name, b.name));

  const contextMenu = useCallback(
    (e: React.MouseEvent, b: Branch) => {
      if (!repo) return;
      const items: MenuItem[] = [
        { label: 'Checkout', onClick: () => void actions.checkoutBranch(b), disabled: b.isCurrent },
        { type: 'separator' },
        { label: 'Merge into current branch…', onClick: () => openDialog({ kind: 'merge', squash: false, preselect: b.name }), disabled: b.isCurrent },
        { label: 'Squash and merge into current branch…', onClick: () => openDialog({ kind: 'merge', squash: true, preselect: b.name }), disabled: b.isCurrent },
        { label: 'Rebase current branch onto…', onClick: () => openDialog({ kind: 'rebase', preselect: b.name }), disabled: b.isCurrent },
        { label: 'Compare…', onClick: () => openDialog({ kind: 'compare' }) },
        { type: 'separator' },
        { label: 'Create worktree for this branch…', icon: 'worktree', onClick: () => { store.set({ popover: null }); openDialog({ kind: 'add-worktree', startBranch: b.name }); } },
        { type: 'separator' },
        { label: 'Rename…', onClick: () => openDialog({ kind: 'rename-branch', branch: b.name }), disabled: b.kind === 'remote' },
        { label: 'Copy branch name', onClick: () => void actions.copyToClipboard(b.name, 'Branch name copied') },
        { label: 'View on GitHub', onClick: () => repo.github && void actions.openExternal(`${repo.github.url}/tree/${encodeURIComponent(b.kind === 'remote' ? b.name.slice(b.name.indexOf('/') + 1) : b.name)}`), disabled: !repo.github },
        { type: 'separator' },
        { label: 'Delete…', danger: true, onClick: () => openDialog({ kind: 'delete-branch', branch: b }), disabled: b.isCurrent },
      ];
      openContextMenu(e, items);
    },
    [repo],
  );

  const row = (b: Branch) => (
    <div key={`${b.kind}:${b.name}`} className={`list-row ${b.isCurrent ? 'selected' : ''}`} onClick={() => void actions.checkoutBranch(b)} onContextMenu={(e) => contextMenu(e, b)} onDoubleClick={() => void actions.checkoutBranch(b)}>
      <Icon name={b.kind === 'remote' ? 'globe' : 'branch'} />
      <span className="row-main">
        <span className="truncate">{b.name}</span>
        <span className="row-sub truncate">{b.lastCommitSubject}</span>
      </span>
      {b.isCurrent ? <Icon name="check" /> : null}
      <span className="row-meta">
        <RelativeTime date={b.lastCommitDate} />
      </span>
    </div>
  );

  return (
    <div className="popover" style={{ left: (isMac ? 76 : 0) + 300, width: 420 }}>
      {repo?.github ? (
        <div className="popover-tabs">
          <button type="button" className={`tab ${tab === 'branches' ? 'active' : ''}`} onClick={() => setTab('branches')}>Branches</button>
          <button type="button" className={`tab ${tab === 'prs' ? 'active' : ''}`} onClick={() => setTab('prs')}>
            Pull requests {prs.list.length ? <Badge>{prs.list.length}</Badge> : null}
          </button>
        </div>
      ) : null}
      {tab === 'branches' ? (
        <>
          <div className="popover-header">
            <FilterInput value={query} onChange={setQuery} placeholder="Filter branches" autoFocus />
            <Button icon="plus" onClick={() => { store.set({ popover: null }); openDialog({ kind: 'new-branch' }); }} title="Create new branch (Ctrl+Shift+N)">New branch</Button>
          </div>
          <div className="popover-list" ref={listRef}>
            {def ? (
              <>
                <div className="list-group-header">Default branch</div>
                {row(def)}
              </>
            ) : null}
            {recent.length ? (
              <>
                <div className="list-group-header">Recent branches</div>
                {recent.map(row)}
              </>
            ) : null}
            {others.length || (current && current.name !== defaultBranch && !recentNames.has(current.name)) ? (
              <>
                <div className="list-group-header">Other branches</div>
                {current && current.name !== defaultBranch && !recentNames.has(current.name) && !others.some((o) => o.isCurrent) ? row(current) : null}
                {others.filter((o) => !o.isCurrent || (o.isCurrent && o.name !== defaultBranch)).map(row)}
              </>
            ) : null}
            {filteredRemote.length ? (
              <>
                <div className="list-group-header">Remote branches</div>
                {filteredRemote.map(row)}
              </>
            ) : null}
            {!filteredLocals.length && !filteredRemote.length ? (
              <div className="list-empty">
                {query ? (
                  <>
                    No branches match “{query}”.
                    <div style={{ marginTop: 8 }}>
                      <Button size="sm" onClick={() => { store.set({ popover: null }); void actions.createBranch(query.trim().replace(/\s+/g, '-'), null, true); }}>Create branch “{query.trim()}”</Button>
                    </div>
                  </>
                ) : (
                  'No branches yet.'
                )}
              </div>
            ) : null}
          </div>
          <div className="popover-footer">
            <span className="muted">{locals.length} local, {remoteOnly.length} remote-only</span>
            <Button size="sm" variant="ghost" icon="pull-request" onClick={() => { store.set({ popover: null }); actions.openPullRequestFlow(); }} disabled={!repo?.github}>Create pull request</Button>
          </div>
        </>
      ) : (
        <PullRequestList prs={prs.list} loading={prs.loading} error={prs.error} query={query} setQuery={setQuery} />
      )}
    </div>
  );
}

const prKeys = (p: PullRequest) => [String(p.number), p.title, p.author, p.headRefName];

const TRIAGE_LABEL: Record<TriageState, string> = {
  'waiting-on-you': 'Waiting on you',
  'waiting-on-author': 'Waiting on author',
  'waiting-on-others': 'Waiting on others',
  'checks-failing': 'Checks failing',
  'ready-to-merge': 'Ready to merge',
  draft: 'Draft',
  stale: 'Stale',
  conflicts: 'Conflicts',
};

const TRIAGE_TONE: Record<TriageState, 'neutral' | 'success' | 'danger' | 'attention' | 'accent' | 'done'> = {
  'waiting-on-you': 'accent',
  'waiting-on-author': 'attention',
  'waiting-on-others': 'neutral',
  'checks-failing': 'danger',
  'ready-to-merge': 'success',
  draft: 'neutral',
  stale: 'neutral',
  conflicts: 'danger',
};

const NEXT_ACTION_LABEL: Record<TriageNextAction, string> = { review: 'Review', checkout: 'Checkout', 'view-checks': 'View checks', merge: 'Merge', rebase: 'Rebase', 'ping-author': 'Ping author', none: '' };

/** Runs a triage-suggested next action by opening the corresponding existing dialog or action; never merges, reviews or comments by itself. */
function runTriageNextAction(pr: PullRequest, nextAction: TriageNextAction): void {
  switch (nextAction) {
    case 'review':
      actions.reviewPullRequest(pr);
      break;
    case 'checkout':
      void actions.checkoutPullRequest(pr);
      break;
    case 'view-checks':
    case 'merge':
      store.set({ popover: null });
      openDialog({ kind: 'pr-details', pr });
      break;
    case 'rebase':
      store.set({ popover: null });
      openDialog({ kind: 'rebase', preselect: pr.baseRefName });
      break;
    case 'ping-author':
      void actions.copyToClipboard(`@${pr.author}`, 'Mention copied');
      break;
    case 'none':
    default:
      break;
  }
}

/** True while the browser reports no network connection; used to disable Summarize (and explain why) while cached triage lines are still shown offline. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

function TriageLine({ pr, cache, login }: { pr: PullRequest; cache: Record<number, PrTriage>; login: string | null }): React.JSX.Element | null {
  const entry = cache[pr.number];
  const fresh = actions.isTriageFresh(entry, pr);
  const state = actions.effectiveTriageState(pr, cache, login);
  if (!state && !entry) return null;
  const nextAction = fresh ? entry!.nextAction : 'none';
  return (
    <span className={`triage-line ${fresh ? '' : 'triage-stale'}`} title={entry ? `${entry.summary}\n\n${entry.reason}` : ''}>
      {state ? <Badge tone={TRIAGE_TONE[state]} title={entry ? entry.reason : undefined}>{TRIAGE_LABEL[state]}</Badge> : null}
      {entry ? <span className="row-sub truncate triage-summary">{entry.summary}</span> : null}
      {nextAction !== 'none' ? (
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); runTriageNextAction(pr, nextAction); }}>
          {NEXT_ACTION_LABEL[nextAction]}
        </Button>
      ) : null}
    </span>
  );
}

function PullRequestList({ prs, loading, error, query, setQuery }: { prs: PullRequest[]; loading: boolean; error: string | null; query: string; setQuery: (q: string) => void }): React.JSX.Element {
  const filtered = useFilter(prs, query, prKeys);
  const current = useAppStore((s) => s.status?.branch.name ?? null);
  const aiEnabled = useAppStore((s) => s.settings?.ai.provider !== 'disabled');
  const triage = useAppStore((s) => s.triage);
  const login = useAppStore((s) => s.tools?.ghAccount?.login ?? null);
  const online = useOnline();
  const [waitingOnly, setWaitingOnly] = useState(false);

  const pendingCount = useMemo(() => actions.pendingTriageNumbers(prs, triage.byNumber).length, [prs, triage.byNumber]);
  const waitingOnYou = useMemo(() => (aiEnabled ? actions.waitingOnYouPrs(prs, triage.byNumber, login) : []), [aiEnabled, prs, triage.byNumber, login]);
  const waitingNumbers = useMemo(() => new Set(waitingOnYou.map((p) => p.number)), [waitingOnYou]);
  const visible = waitingOnly ? filtered.filter((pr) => waitingNumbers.has(pr.number)) : filtered;

  return (
    <>
      <div className="popover-header">
        <FilterInput value={query} onChange={setQuery} placeholder="Filter pull requests" autoFocus />
        <Button iconOnly icon="sync" variant="ghost" title="Refresh" aria-label="Refresh pull requests" onClick={() => void actions.loadPullRequests(true)} disabled={loading} />
      </div>
      {aiEnabled ? (
        <div className="popover-header triage-bar">
          <label className="checkbox-inline">
            <input type="checkbox" checked={waitingOnly} onChange={(e) => setWaitingOnly(e.target.checked)} />
            Waiting on you {waitingOnYou.length ? <Badge tone="accent">{waitingOnYou.length}</Badge> : null}
          </label>
          {triage.loading ? (
            <span className="muted">
              <Spinner /> Summarizing{triage.progress ? ` ${triage.progress.done}/${triage.progress.total}` : ''}…
              <Button size="sm" variant="ghost" onClick={() => actions.cancelTriage()}>Cancel</Button>
            </span>
          ) : pendingCount ? (
            <Button size="sm" variant="ghost" icon="sparkle" className="sparkle" disabled={!online} title={online ? undefined : 'Offline — cached triage lines are still shown'} onClick={() => void actions.summarizePullRequests()}>
              Summarize {pendingCount} pull request{pendingCount === 1 ? '' : 's'}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="popover-list">
        {loading && !prs.length ? (
          <div className="list-empty">
            <Spinner /> Loading pull requests…
          </div>
        ) : null}
        {error ? (
          <div className="list-empty">
            {error}
            <div style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in to GitHub</Button>
            </div>
          </div>
        ) : null}
        {!loading && !error && !visible.length ? <div className="list-empty">{!filtered.length ? (prs.length ? 'No matching pull requests.' : 'No open pull requests.') : 'No pull requests are waiting on you.'}</div> : null}
        {visible.map((pr) => (
          <div
            key={pr.number}
            className={`list-row pr-row ${pr.headRefName === current ? 'selected' : ''}`}
            onClick={() => void actions.checkoutPullRequest(pr)}
            onContextMenu={(e) =>
              openContextMenu(e, [
                { label: 'Checkout', onClick: () => void actions.checkoutPullRequest(pr) },
                { label: 'View details…', onClick: () => { store.set({ popover: null }); openDialog({ kind: 'pr-details', pr }); } },
                ...(aiEnabled ? [{ label: 'Review with AI…', icon: 'sparkle' as const, onClick: () => actions.reviewPullRequest(pr) }] : []),
                { label: 'Open on GitHub', onClick: () => void actions.openExternal(pr.url) },
                { label: 'Copy URL', onClick: () => void actions.copyToClipboard(pr.url, 'URL copied') },
              ])
            }
          >
            <Icon name="pull-request" className={pr.isDraft ? 'muted' : ''} />
            <span className="row-main">
              <span className="truncate">
                {pr.title} <span className="pr-number">#{pr.number}</span>
              </span>
              <span className="row-sub truncate">
                {pr.isDraft ? 'Draft · ' : ''}
                {pr.author} · {pr.headRefName} → {pr.baseRefName} · <RelativeTime date={pr.updatedAt} />
              </span>
              {aiEnabled ? <TriageLine pr={pr} cache={triage.byNumber} login={login} /> : null}
            </span>
            {pr.checks.state !== 'none' ? <span className={`check-dot ${pr.checks.state}`} title={`Checks: ${pr.checks.passed} passed, ${pr.checks.failed} failed, ${pr.checks.pending} pending`} /> : null}
            {aiEnabled ? <Button size="sm" variant="ghost" iconOnly icon="sparkle" className="sparkle" title="Review with AI" aria-label="Review pull request with AI" onClick={(e) => { e.stopPropagation(); actions.reviewPullRequest(pr); }} /> : null}
            <Button size="sm" variant="ghost" iconOnly icon="info" title="Details" aria-label="View pull request details" onClick={(e) => { e.stopPropagation(); store.set({ popover: null }); openDialog({ kind: 'pr-details', pr }); }} />
          </div>
        ))}
      </div>
    </>
  );
}

function InboxBell(): React.JSX.Element | null {
  const gh = useAppStore((s) => s.tools?.gh ?? null);
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  const inbox = useAppStore((s) => s.inbox);
  const open = useAppStore((s) => s.inboxUi.open);
  if (gh && !gh.installed) return null; // the bell is hidden entirely when the GitHub CLI is unavailable
  const pausedLabel = inbox.paused === 'rate-limit' ? 'Notifications paused: rate limited' : inbox.paused === 'scope' ? 'Notifications need access to be granted' : inbox.paused === 'offline' ? 'Notifications offline — showing the cached list' : null;
  const title = !account ? 'Sign in to see notifications' : (pausedLabel ?? `Notifications${inbox.unreadCount ? ` — ${inbox.unreadCount} unread` : ''} (Ctrl+Shift+J)`);
  return (
    <Button variant="ghost" iconOnly className={`inbox-bell ${open ? 'open' : ''}`} onClick={() => actions.toggleInboxPanel()} title={title} aria-label={title}>
      <Icon name="bell" className="icon" />
      {!account ? <span className="inbox-dot" /> : inbox.unreadCount > 0 ? <span className="inbox-count">{inbox.unreadCount > 99 ? '99+' : inbox.unreadCount}</span> : null}
      {account && pausedLabel ? <span className="inbox-paused-marker" /> : null}
    </Button>
  );
}

export function AccountAvatar(): React.JSX.Element | null {
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  if (!account) return null;
  return <Avatar email={`${account.login}@users.noreply.github.com`} name={account.name ?? account.login} />;
}
