import React, { useEffect, useState } from 'react';
import type { Housekeeping, LargeBlob, StaleBranch } from '@shared/types';
import { formatBytes } from '@shared/util';
import { errorInfo, errorMessage, invoke } from '../api';
import * as actions from '../state/actions';
import { store, useAppStore } from '../state/store';
import { Button, Checkbox, Icon, RelativeTime, Spinner } from './ui';

type CardStatus = 'idle' | 'loading' | 'error';

const LARGE_FILE_LIMIT = 25;

/** Full-screen view (four independently loading cards) for diagnosing what makes a repository slow or risky. */
export function HealthView(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const unborn = useAppStore((s) => s.status?.branch.unborn ?? false);

  return (
    <div className="health-view">
      <div className="changes-header">
        <Icon name="alert" />
        <span className="count">Repository health{repo ? ` — ${repo.alias ?? repo.name}` : ''}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" iconOnly icon="x" title="Back to changes" onClick={() => actions.setView('changes')} />
      </div>
      {unborn ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <Icon name="repo" size={28} />
          <p>This repository has no commits yet.</p>
          <p className="muted" style={{ fontSize: 12 }}>Make your first commit to see its health.</p>
        </div>
      ) : (
        <div className="health-grid">
          <LargeFilesCard />
          <StaleBranchesCard />
          <UnpushedWorkCard />
          <HousekeepingCard />
        </div>
      )}
    </div>
  );
}

function CardChrome({ icon, title, status, error, onRetry, onRescan, children, footer }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; status: CardStatus; error?: string | null; onRetry: () => void; onRescan?: () => void; children: React.ReactNode; footer?: React.ReactNode }): React.JSX.Element {
  return (
    <section className="health-card">
      <header className="health-card-header">
        <Icon name={icon} />
        <h3>{title}</h3>
        {status === 'loading' ? <Spinner /> : null}
        <span style={{ flex: 1 }} />
        {status !== 'loading' && onRescan ? <Button size="sm" variant="ghost" iconOnly icon="sync" title="Rescan" onClick={onRescan} /> : null}
      </header>
      <div className="health-card-body">
        {status === 'error' ? (
          <div className="health-card-error">
            <p>{error ?? 'Something went wrong.'}</p>
            <Button size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : (
          children
        )}
      </div>
      {footer && status !== 'error' ? <div className="health-card-actions">{footer}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Large files
// ---------------------------------------------------------------------------

function LargeFilesCard(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const threshold = useAppStore((s) => s.settings?.healthLargeFileThresholdBytes ?? 5 * 1024 * 1024);
  const progress = useAppStore((s) => Object.values(s.progress).find((p) => p.repoPath === repo?.path && p.title === 'Scanning for large files') ?? null);
  const [status, setStatus] = useState<CardStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [blobs, setBlobs] = useState<LargeBlob[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [lfsInstalled, setLfsInstalled] = useState(false);

  const load = async (): Promise<void> => {
    if (!repo) return;
    setStatus('loading');
    setCancelled(false);
    try {
      const [result, tools] = await Promise.all([invoke('repo.health.largeFiles', repo.path, LARGE_FILE_LIMIT), invoke('app.tools', false)]);
      setBlobs(result);
      setLfsInstalled(tools.gitLfs.installed);
      setStatus('idle');
    } catch (err) {
      // A cancelled scan returns to idle, keeping whatever results the previous scan found.
      if (errorInfo(err).code === 'cancelled') {
        setCancelled(true);
        setStatus('idle');
      } else {
        setError(errorMessage(err));
        setStatus('error');
      }
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  return (
    <CardChrome icon="file" title="Large files" status={status} error={error} onRetry={() => void load()} onRescan={() => void load()}>
      {status === 'loading' && progress ? (
        <div className="list-empty">
          <Spinner /> Scanning history…
          <Button size="sm" variant="ghost" onClick={() => void invoke('app.operations.cancel', progress.id)}>Cancel</Button>
        </div>
      ) : cancelled && !blobs.length ? (
        <p className="muted">Scan cancelled.</p>
      ) : !blobs.length ? (
        <p className="muted">No large blobs found in history.</p>
      ) : (
        <ul className="health-list">
          {blobs.map((b) => (
            <li key={`${b.sha}:${b.path}`} className="health-row">
              {b.size >= threshold ? <Icon name="alert" size={14} className="warning-dot" title={`At or above the ${formatBytes(threshold)} warning threshold`} /> : <span className="health-row-spacer" />}
              <span className="row-main">
                <span className="truncate" title={b.path}>{b.path}</span>
                <span className="row-sub truncate">
                  {formatBytes(b.size)} · {b.atHead ? 'at HEAD' : 'not at HEAD'}
                  {b.firstCommitDate ? (
                    <>
                      {' '}
                      · added <RelativeTime date={b.firstCommitDate} />
                    </>
                  ) : null}
                </span>
              </span>
              <span className="health-row-actions">
                <Button size="sm" variant="ghost" onClick={() => void actions.copyToClipboard(b.path, 'Path copied')}>Copy path</Button>
                <Button size="sm" variant="ghost" onClick={() => void actions.ignore([b.path])}>Add to .gitignore</Button>
                {lfsInstalled ? <Button size="sm" variant="ghost" onClick={() => void actions.setLfsTracking(b.path, true)}>Track with LFS</Button> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardChrome>
  );
}

// ---------------------------------------------------------------------------
// Stale branches
// ---------------------------------------------------------------------------

function StaleBranchesCard(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const settings = useAppStore((s) => s.settings);
  const branchesVersion = useAppStore((s) => s.branches);
  const [status, setStatus] = useState<CardStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<StaleBranch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async (): Promise<void> => {
    if (!repo) return;
    setStatus('loading');
    try {
      const days = settings?.staleBranchDays ?? 90;
      const result = await invoke('repo.health.staleBranches', repo.path, days);
      setBranches(result);
      setSelected(new Set());
      setStatus('idle');
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path, branchesVersion]);

  const toggle = (name: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectable = branches.filter((b) => !b.protected);
  const allSelected = selectable.length > 0 && selectable.every((b) => selected.has(b.name));

  return (
    <CardChrome
      icon="branch"
      title="Stale branches"
      status={status}
      error={error}
      onRetry={() => void load()}
      onRescan={() => void load()}
      footer={
        branches.length ? (
          <>
            {selectable.length ? (
              <Checkbox checked={allSelected ? true : selected.size ? 'indeterminate' : false} onChange={(v) => setSelected(v ? new Set(selectable.map((b) => b.name)) : new Set())} label="Select all" />
            ) : null}
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="danger" disabled={!selected.size} onClick={() => actions.openBulkDeleteBranches(branches.filter((b) => selected.has(b.name)))}>
              Delete{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </>
        ) : null
      }
    >
      {!branches.length ? (
        <p className="muted">No merged, inactive or upstream-gone branches.</p>
      ) : (
        <ul className="health-list">
          {branches.map((b) => (
            <li key={b.name} className="health-row">
              {!b.protected ? (
                <Checkbox checked={selected.has(b.name)} onChange={() => toggle(b.name)} />
              ) : (
                <span className="health-row-spacer" title="The current, default and protected branches cannot be deleted here." />
              )}
              <span className="row-main">
                <span className="truncate">{b.name}</span>
                <span className="row-sub truncate">
                  {b.reason.join(', ')} · <RelativeTime date={b.lastCommitDate} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardChrome>
  );
}

// ---------------------------------------------------------------------------
// Unpushed work
// ---------------------------------------------------------------------------

function UnpushedWorkCard(): React.JSX.Element {
  const work = useAppStore((s) => s.work);
  const [status, setStatus] = useState<CardStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setStatus('loading');
    try {
      const result = await invoke('repos.work');
      store.set({ work: result });
      setStatus('idle');
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const withWork = work.filter((w) => w.aheadBranches.length || w.unpublishedBranches.length || w.stashCount > 0 || w.uncommittedCount > 0);

  return (
    <CardChrome icon="sync" title="Unpushed work" status={status} error={error} onRetry={() => void load()} onRescan={() => void load()}>
      {!withWork.length ? (
        <p className="muted">Every repository is pushed and clean.</p>
      ) : (
        <ul className="health-list">
          {withWork.map((w) => (
            <li key={w.repoId} className="health-row">
              <span className="row-main">
                <span className="truncate">{w.repoName}</span>
                <span className="row-sub truncate">
                  {w.aheadBranches.map((b) => (
                    <Button key={b.name} size="sm" variant="link" onClick={() => void actions.openRepoWorkEntry(w, b.name)}>
                      {b.name} +{b.ahead}
                    </Button>
                  ))}
                  {w.unpublishedBranches.length ? ` · ${w.unpublishedBranches.length} unpublished` : ''}
                  {w.stashCount ? ` · ${w.stashCount} stash${w.stashCount === 1 ? '' : 'es'}` : ''}
                  {w.uncommittedCount ? ` · ${w.uncommittedCount} uncommitted change${w.uncommittedCount === 1 ? '' : 's'}` : ''}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void actions.openRepoWorkEntry(w)}>Open</Button>
            </li>
          ))}
        </ul>
      )}
    </CardChrome>
  );
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

function HousekeepingCard(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  // Blocked while a merge/rebase/cherry-pick/revert is in progress (persistent, on-disk state), while
  // the renderer is mid-way through another tracked operation (push, checkout, apply stash, ...), or
  // while a fetch/pull/push/generic scan is streaming progress for this repository.
  const operationInProgress = useAppStore((s) => (s.status ? s.status.operation.kind !== 'none' : false) || !!s.operation || Object.values(s.progress).some((p) => !p.repoPath || p.repoPath === repo?.path));
  const [status, setStatus] = useState<CardStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Housekeeping | null>(null);

  const load = async (): Promise<void> => {
    if (!repo) return;
    setStatus('loading');
    try {
      const result = await invoke('repo.health.housekeeping', repo.path);
      setData(result);
      setStatus('idle');
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  return (
    <CardChrome
      icon="folder"
      title="Housekeeping"
      status={status}
      error={error}
      onRetry={() => void load()}
      onRescan={() => void load()}
      footer={
        <>
          <Button size="sm" disabled={operationInProgress} onClick={() => actions.confirmRunGc(() => void load())}>Run gc</Button>
          <Button size="sm" disabled={operationInProgress} onClick={() => actions.confirmPruneRemotes(() => void load())}>Prune remotes</Button>
          <Button size="sm" variant="danger" disabled={operationInProgress} onClick={() => actions.confirmExpireReflog(() => void load())}>Expire reflog</Button>
        </>
      }
    >
      {!data ? (
        <div className="list-empty">
          <Spinner />
        </div>
      ) : (
        <dl className="health-stats">
          <div>
            <dt>.git directory</dt>
            <dd>{formatBytes(data.gitDirBytes)}</dd>
          </div>
          <div>
            <dt>Loose objects</dt>
            <dd>
              {data.looseObjectCount} ({formatBytes(data.looseObjectBytes)})
            </dd>
          </div>
          <div>
            <dt>Packs</dt>
            <dd>
              {data.packCount} ({formatBytes(data.packBytes)})
            </dd>
          </div>
          <div>
            <dt>Garbage</dt>
            <dd>
              {data.garbageCount} ({formatBytes(data.garbageBytes)})
            </dd>
          </div>
          <div>
            <dt>Last gc</dt>
            <dd>{data.lastGcAt ? <RelativeTime date={data.lastGcAt} /> : 'never'}</dd>
          </div>
        </dl>
      )}
      {operationInProgress ? <p className="muted" style={{ fontSize: 12 }}>Housekeeping actions are disabled while an operation is in progress.</p> : null}
    </CardChrome>
  );
}
