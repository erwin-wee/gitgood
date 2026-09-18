import React, { useEffect } from 'react';
import * as actions from '../state/actions';
import { openDialog, useAppStore } from '../state/store';
import { Button, Icon, RelativeTime } from './ui';

export function Welcome(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos);
  const work = useAppStore((s) => s.work);
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  const recent = [...repos].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 6);

  useEffect(() => {
    void actions.loadWork();
  }, []);

  const withWork = work.filter((w) => w.aheadBranches.length || w.unpublishedBranches.length || w.stashCount > 0 || w.uncommittedCount > 0);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Let's get started</h1>
        <p className="lead">{account ? `Signed in as ${account.login}. ` : ''}Add a repository to GitGood, or create a new one.</p>
        <div className="welcome-actions">
          <button type="button" className="welcome-action" onClick={() => openDialog({ kind: 'clone' })}>
            <Icon name="download" size={20} />
            <strong>Clone a repository</strong>
            <span>From GitHub.com or any URL</span>
          </button>
          <button type="button" className="welcome-action" onClick={() => openDialog({ kind: 'new-repo' })}>
            <Icon name="plus" size={20} />
            <strong>Create a new repository</strong>
            <span>Start fresh on your hard drive</span>
          </button>
          <button type="button" className="welcome-action" onClick={() => openDialog({ kind: 'add-repo' })}>
            <Icon name="folder" size={20} />
            <strong>Add an existing repository</strong>
            <span>Pick a folder that already has a .git directory</span>
          </button>
        </div>
        {!account ? (
          <p className="muted">
            <Button variant="link" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in to GitHub</Button> to browse your repositories and work with pull requests.
          </p>
        ) : null}
        {recent.length ? (
          <div className="welcome-recent">
            <h3>Recent repositories</h3>
            {recent.map((r) => (
              <div key={r.id} className={`list-row ${r.missing ? 'disabled' : ''}`} onClick={() => void actions.openRepository(r)} style={{ borderRadius: 6 }}>
                <Icon name={r.github ? 'github' : 'repo'} />
                <span className="row-main">
                  <span>{r.alias ?? r.name}</span>
                  <span className="row-sub truncate">{r.path}</span>
                </span>
                <span className="row-meta">
                  <RelativeTime date={r.lastOpened} />
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {withWork.length ? (
          <div className="welcome-recent">
            <h3>Repository health</h3>
            {withWork.map((w) => (
              <div key={w.repoId} className="list-row" onClick={() => void actions.openRepoWorkEntry(w)} style={{ borderRadius: 6 }}>
                <Icon name="alert" />
                <span className="row-main">
                  <span>{w.repoName}</span>
                  <span className="row-sub truncate">
                    {w.aheadBranches.length ? `${w.aheadBranches.length} branch${w.aheadBranches.length === 1 ? '' : 'es'} ahead` : ''}
                    {w.unpublishedBranches.length ? ` · ${w.unpublishedBranches.length} unpublished` : ''}
                    {w.stashCount ? ` · ${w.stashCount} stash${w.stashCount === 1 ? '' : 'es'}` : ''}
                    {w.uncommittedCount ? ` · ${w.uncommittedCount} uncommitted change${w.uncommittedCount === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
