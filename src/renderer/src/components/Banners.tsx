import React, { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/types';
import { formatRelativeTime } from '@shared/util';
import * as actions from '../state/actions';
import { openDialog, store, useAppStore } from '../state/store';
import { on } from '../api';
import { Button, Icon, Spinner } from './ui';

function lfsInstallHint(platform: string): string {
  if (platform === 'darwin') return 'brew install git-lfs';
  if (platform === 'win32') return 'winget install GitHub.GitLFS';
  return 'sudo apt install git-lfs  (or see git-lfs.com for your distribution)';
}

/** The update banner, at the lowest priority (rendered last, after every repository-specific banner). Shown even with no repository open (e.g. the Welcome screen). */
function updateBanner(updateState: UpdateState): React.JSX.Element | null {
  if (updateState.status === 'available' && !updateState.dismissed) {
    return (
      <div key="update" className="banner info">
        <Icon name="download" />
        <span className="banner-text">
          <strong>GitGood {updateState.version} is available.</strong>
          {updateState.releaseDate ? ` Released ${formatRelativeTime(updateState.releaseDate)}.` : ' A new version has been published.'}
        </span>
        <span className="banner-actions">
          <Button size="sm" variant="primary" icon="download" onClick={() => void actions.downloadUpdate()}>Download</Button>
          <Button size="sm" onClick={() => actions.openUpdateNotes()}>Release notes</Button>
          <Button size="sm" variant="ghost" onClick={() => void actions.dismissUpdate(updateState.version)}>Later</Button>
        </span>
      </div>
    );
  }
  if (updateState.status === 'downloading') {
    return (
      <div key="update" className="banner info">
        <Spinner />
        <span className="banner-text">
          <strong>Downloading GitGood {updateState.version}…</strong>
          {updateState.percent != null ? ` ${Math.round(updateState.percent)}%` : ''}
        </span>
      </div>
    );
  }
  if (updateState.status === 'ready') {
    return (
      <div key="update" className="banner info">
        <Icon name="download" />
        <span className="banner-text">
          <strong>GitGood {updateState.version} is ready to install.</strong> Restart to finish updating.
        </span>
        <span className="banner-actions">
          <Button size="sm" variant="primary" onClick={() => void actions.installUpdate()}>Restart to update</Button>
          <Button size="sm" onClick={() => actions.openUpdateNotes()}>Release notes</Button>
        </span>
      </div>
    );
  }
  return null;
}

/** Post-resolution check failure banner: shows the command and a "Show output" toggle, plus a single "Ask AI to fix" retry (hidden after it has already been used once for this file). */
function CheckFailedBanner(): React.JSX.Element | null {
  const banner = useAppStore((s) => s.checkBanner);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const [expanded, setExpanded] = useState(false);
  if (!banner) return null;
  const { path, result, retried } = banner;
  return (
    <div key="check-failed" className="banner danger">
      <Icon name="alert" />
      <span className="banner-text">
        <strong>Post-resolution check failed for {path}</strong>
        {result.timedOut ? 'The check timed out.' : `Exit code ${result.exitCode ?? 'unknown'}.`} {result.fromRepo ? 'Command came from this repository.' : ''} <code className="mono">{result.command}</code>
        {expanded ? <pre className="details-block">{result.outputTail}</pre> : null}
      </span>
      <span className="banner-actions">
        <Button size="sm" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Hide output' : 'Show output'}</Button>
        {!retried ? <Button size="sm" variant="accent" icon="sparkle" loading={aiBusy} onClick={() => void actions.retryResolutionWithCheckOutput(path)}>Ask AI to fix</Button> : null}
        <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss check failure" onClick={() => actions.dismissCheckBanner()} />
      </span>
    </div>
  );
}

const TOOL_UPDATE_HELP: Record<'git' | 'gh', { label: string; url: string; hint: (platform: string) => string }> = {
  git: { label: 'Git', url: 'https://git-scm.com/downloads', hint: (p) => (p === 'win32' ? 'winget upgrade --id Git.Git -e' : p === 'darwin' ? 'brew upgrade git' : 'update the git package with your package manager') },
  gh: { label: 'GitHub CLI', url: 'https://cli.github.com', hint: (p) => (p === 'win32' ? 'winget upgrade --id GitHub.cli -e' : p === 'darwin' ? 'brew upgrade gh' : 'update gh as described on cli.github.com') },
};

/** Warns (never blocks) when git or gh is older than the supported minimum; dismissible for the session. */
function useToolsOutdatedBanner(): React.JSX.Element | null {
  const tools = useAppStore((s) => s.tools);
  const [dismissed, setDismissed] = useState(false);
  const outdated = (['git', 'gh'] as const).filter((t) => tools?.[t].outdated);
  if (!tools || dismissed || !outdated.length) return null;
  const platform = window.gitgoodBridge.platform;
  return (
    <div key="tools-outdated" className="banner">
      <Icon name="alert" />
      <span className="banner-text">
        {outdated.map((t) => (
          <span key={t} style={{ display: 'block' }}>
            <strong>{TOOL_UPDATE_HELP[t].label} {tools[t].version} is older than the supported minimum {tools[t].minVersion}.</strong> Some features may fail. Update: <code className="mono">{TOOL_UPDATE_HELP[t].hint(platform)}</code> or download from <Button variant="link" onClick={() => void actions.openExternal(TOOL_UPDATE_HELP[t].url)}>{TOOL_UPDATE_HELP[t].url.replace('https://', '')}</Button>.
          </span>
        ))}
      </span>
      <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss tool version notice" onClick={() => setDismissed(true)} />
    </div>
  );
}

/** Event-socket state of a browser tab or remote-server session (see src/server/web-bridge.ts); null while healthy. */
function useServerBanner(): React.JSX.Element | null {
  const [connected, setConnected] = useState(true);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  useEffect(() => {
    const offs = [on('server.connection', (p) => setConnected(p.connected)), on('server.updated', (p) => setUpdatedTo(p.version))];
    return () => offs.forEach((off) => off());
  }, []);
  if (!connected) {
    return (
      <div key="server-connection" className="banner danger" role="status">
        <Spinner />
        <span className="banner-text"><strong>Reconnecting to server…</strong> Changes made elsewhere will appear once the connection is back.</span>
      </div>
    );
  }
  if (updatedTo) {
    return (
      <div key="server-updated" className="banner info" role="status">
        <Icon name="download" />
        <span className="banner-text"><strong>GitGood server was updated to {updatedTo}.</strong> Reload to use the new version.</span>
        <span className="banner-actions">
          <Button size="sm" variant="primary" onClick={() => window.location.reload()}>Reload</Button>
        </span>
      </div>
    );
  }
  return null;
}

export function Banners(): React.JSX.Element | null {
  const status = useAppStore((s) => s.status);
  const repo = useAppStore((s) => s.currentRepo);
  const tools = useAppStore((s) => s.tools);
  const merge = useAppStore((s) => s.lastSuccessfulMerge);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const submodules = useAppStore((s) => s.submodules);
  const lfsStatus = useAppStore((s) => s.lfsStatus);
  const submoduleBannerDismissed = useAppStore((s) => s.submoduleBannerDismissed);
  const updateState = useAppStore((s) => s.updateState);
  const checkBanner = useAppStore((s) => s.checkBanner);
  const [dismissedMerge, setDismissedMerge] = useState<number | null>(null);
  const [dismissedLfsRepo, setDismissedLfsRepo] = useState<string | null>(null);
  const uninitializedSubmodules = submodules.filter((s) => s.state === 'uninitialized');
  const showLfsBanner = !!(repo && lfsStatus && lfsStatus.usedByRepo && !lfsStatus.installed);

  useEffect(() => {
    if (!merge) return;
    const t = setTimeout(() => store.set({ lastSuccessfulMerge: null }), 12000);
    return () => clearTimeout(t);
  }, [merge]);

  useEffect(() => {
    if (!uninitializedSubmodules.length || submoduleBannerDismissed) return;
    const t = setTimeout(() => store.set({ submoduleBannerDismissed: true }), 8000);
    return () => clearTimeout(t);
  }, [submoduleBannerDismissed, uninitializedSubmodules.length]);

  useEffect(() => {
    const repoPath = repo?.path;
    if (!showLfsBanner || !repoPath || dismissedLfsRepo === repoPath) return;
    const t = setTimeout(() => setDismissedLfsRepo(repoPath), 8000);
    return () => clearTimeout(t);
  }, [dismissedLfsRepo, repo?.path, showLfsBanner]);

  const update = updateBanner(updateState);
  const serverBanner = useServerBanner();
  const toolsBanner = useToolsOutdatedBanner();
  if (!repo || !status) return update || serverBanner || toolsBanner ? <div className="banner-stack">{serverBanner}{toolsBanner}{update}</div> : null;
  const banners: React.ReactNode[] = [];
  const op = status.operation;

  if (op.kind !== 'none' && op.kind !== 'bisect') {
    const label = op.kind === 'merge' ? `Merging ${op.targetName ?? op.targetSha?.slice(0, 7) ?? ''} into ${status.branch.name ?? 'current branch'}` : op.kind === 'rebase' ? `Rebasing ${op.headName ?? ''} onto ${op.ontoName ?? op.onto?.slice(0, 7) ?? ''}${op.current && op.total ? ` (${op.current}/${op.total})` : ''}` : op.kind === 'cherry-pick' ? `Cherry-picking ${op.targetSha?.slice(0, 7) ?? ''}` : `Reverting ${op.targetSha?.slice(0, 7) ?? ''}`;
    const conflicts = status.files.filter((f) => f.conflict).length;
    banners.push(
      <div key="operation-conflicts" className={`banner ${conflicts ? 'danger' : 'info'}`}>
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

  if (checkBanner) banners.push(<CheckFailedBanner key="check-failed" />);

  if (merge && dismissedMerge !== merge.at) {
    banners.push(
      <div key="merged" className="banner success">
        <Icon name="check-circle" />
        <span className="banner-text">
          Successfully merged <strong>{merge.branch}</strong> into <strong>{status.branch.name}</strong>.
        </span>
        <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss merge notification" onClick={() => setDismissedMerge(merge.at)} />
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

  if (uninitializedSubmodules.length && !submoduleBannerDismissed) {
    banners.push(
      <div key="submodules" className="banner info">
        <Icon name="folder" />
        <span className="banner-text">
          This repository has {uninitializedSubmodules.length} uninitialized submodule{uninitializedSubmodules.length === 1 ? '' : 's'}; {uninitializedSubmodules.length === 1 ? 'its directory is' : 'their directories are'} empty until initialized.
        </span>
        <span className="banner-actions">
          <Button size="sm" variant="primary" onClick={() => void actions.initializeAndUpdateAllSubmodules()}>Initialize and update all</Button>
          <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss submodule notice" onClick={() => store.set({ submoduleBannerDismissed: true })} />
        </span>
      </div>,
    );
  }

  if (showLfsBanner && dismissedLfsRepo !== repo.path) {
    banners.push(
      <div key="lfs" className="banner danger">
        <Icon name="alert" />
        <span className="banner-text">
          <strong>This repository uses Git LFS, which is not installed.</strong>
          Large files show as pointers only until it is installed. Install with <code className="mono">{lfsInstallHint(window.gitgoodBridge.platform)}</code>, then reopen this repository.
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

  if (update) banners.push(update);
  if (toolsBanner) banners.push(toolsBanner);
  if (serverBanner) banners.unshift(serverBanner);
  return banners.length ? <div className="banner-stack">{banners}</div> : null;
}
