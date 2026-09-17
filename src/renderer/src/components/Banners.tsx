import React, { useEffect, useState } from 'react';
import * as actions from '../state/actions';
import { openDialog, store, useAppStore } from '../state/store';
import { Button, Icon, Spinner } from './ui';

export function Banners(): React.JSX.Element | null {
  const status = useAppStore((s) => s.status);
  const repo = useAppStore((s) => s.currentRepo);
  const tools = useAppStore((s) => s.tools);
  const merge = useAppStore((s) => s.lastSuccessfulMerge);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const [dismissedMerge, setDismissedMerge] = useState<number | null>(null);

  useEffect(() => {
    if (!merge) return;
    const t = setTimeout(() => store.set({ lastSuccessfulMerge: null }), 12000);
    return () => clearTimeout(t);
  }, [merge]);

  if (!repo || !status) return null;
  const banners: React.ReactNode[] = [];
  const op = status.operation;

  if (op.kind !== 'none' && op.kind !== 'bisect') {
    const label = op.kind === 'merge' ? `Merging ${op.targetName ?? op.targetSha?.slice(0, 7) ?? ''} into ${status.branch.name ?? 'current branch'}` : op.kind === 'rebase' ? `Rebasing ${op.headName ?? ''} onto ${op.ontoName ?? op.onto?.slice(0, 7) ?? ''}${op.current && op.total ? ` (${op.current}/${op.total})` : ''}` : op.kind === 'cherry-pick' ? `Cherry-picking ${op.targetSha?.slice(0, 7) ?? ''}` : `Reverting ${op.targetSha?.slice(0, 7) ?? ''}`;
    const conflicts = status.files.filter((f) => f.conflict).length;
    banners.push(
      <div key="op" className={`banner ${conflicts ? 'danger' : 'info'}`}>
        {aiBusy ? <Spinner /> : <Icon name={conflicts ? 'alert' : op.kind === 'merge' ? 'merge' : 'branch'} />}
        <span className="banner-text">
          <strong>{label}</strong>
          {conflicts ? `${conflicts} file${conflicts === 1 ? ' has' : 's have'} conflicts that must be resolved before continuing.` : `All conflicts resolved. Continue to finish the ${op.kind}.`}
        </span>
        <span className="banner-actions">
          {conflicts ? (
            <Button size="sm" variant="accent" icon="sparkle" onClick={() => openDialog({ kind: 'conflicts' })}>Resolve conflicts</Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void actions.continueOperation()}>{op.kind === 'merge' ? 'Commit merge' : `Continue ${op.kind}`}</Button>
          )}
          <Button size="sm" onClick={() => void actions.abortOperation()}>Abort</Button>
        </span>
      </div>,
    );
  }

  if (merge && dismissedMerge !== merge.at) {
    banners.push(
      <div key="merged" className="banner success">
        <Icon name="check-circle" />
        <span className="banner-text">
          Successfully merged <strong>{merge.branch}</strong> into <strong>{status.branch.name}</strong>.
        </span>
        <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setDismissedMerge(merge.at)} />
      </div>,
    );
  }

  if (status.branch.detached && op.kind === 'none') {
    banners.push(
      <div key="detached" className="banner">
        <Icon name="alert" />
        <span className="banner-text">
          <strong>Detached HEAD</strong>
          You are not on a branch. Commits you make here are easy to lose; create a branch to keep them.
        </span>
        <span className="banner-actions">
          <Button size="sm" onClick={() => openDialog({ kind: 'new-branch' })}>Create branch</Button>
        </span>
      </div>,
    );
  }

  if (status.branch.upstreamGone && op.kind === 'none') {
    banners.push(
      <div key="gone" className="banner">
        <Icon name="info" />
        <span className="banner-text">
          The upstream branch <strong>{status.branch.upstream}</strong> no longer exists on the remote (it may have been merged and deleted).
        </span>
        <span className="banner-actions">
          <Button size="sm" onClick={() => void actions.pushWithErrorHandling()}>Publish again</Button>
          {store.get().defaultBranch ? <Button size="sm" onClick={() => { const def = store.get().branches.find((b) => b.kind === 'local' && b.name === store.get().defaultBranch); if (def) void actions.checkoutBranch(def); }}>Switch to {store.get().defaultBranch}</Button> : null}
        </span>
      </div>,
    );
  }

  if (repo.github && tools && tools.gh.installed && !tools.ghAccount) {
    banners.push(
      <div key="signin" className="banner info">
        <Icon name="github" />
        <span className="banner-text">Sign in to GitHub to see pull requests and push to private repositories without extra setup.</span>
        <span className="banner-actions">
          <Button size="sm" variant="primary" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in</Button>
        </span>
      </div>,
    );
  }

  return banners.length ? <>{banners}</> : null;
}
