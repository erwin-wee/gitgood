import React, { useEffect, useMemo, useState } from 'react';
import type { GitHubRepoSummary, RepositoryInfo } from '@shared/types';
import { compareStrings } from '@shared/util';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, store, useAppStore, type RepoSettingsTab } from '../../state/store';
import { Avatar, Button, Callout, Checkbox, Dialog, FilterInput, Icon, Spinner, TextField, useFilter } from '../ui';

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

const repoKeys = (r: GitHubRepoSummary) => [r.nameWithOwner, r.description ?? ''];

export function CloneDialog({ initialUrl }: { initialUrl?: string }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  const [tab, setTab] = useState<'github' | 'url'>(account ? 'github' : 'url');
  const [url, setUrl] = useState(initialUrl ?? '');
  const [directory, setDirectory] = useState(settings?.defaultCloneDirectory ?? '');
  const [dirTouched, setDirTouched] = useState(false);
  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GitHubRepoSummary | null>(null);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useAppStore((s) => Object.values(s.progress).find((p) => p.kind === 'clone') ?? null);

  const loadRepos = async () => {
    setLoadingRepos(true);
    setReposError(null);
    try {
      setRepos(await invoke('gh.repos.list'));
    } catch (err) {
      setReposError(errorMessage(err));
    } finally {
      setLoadingRepos(false);
    }
  };
  useEffect(() => {
    if (tab === 'github' && account && repos === null && !loadingRepos) void loadRepos();
  }, [tab, account, repos, loadingRepos]);

  const filtered = useFilter(repos ?? [], query, repoKeys);
  const grouped = useMemo(() => {
    const map = new Map<string, GitHubRepoSummary[]>();
    for (const r of filtered) (map.get(r.owner) ?? map.set(r.owner, []).get(r.owner)!).push(r);
    return [...map.entries()].sort((a, b) => (a[0] === account?.login ? -1 : b[0] === account?.login ? 1 : compareStrings(a[0], b[0])));
  }, [filtered, account]);

  const effectiveUrl = tab === 'github' ? selected?.cloneUrl ?? '' : url.trim();
  const repoName = useMemo(() => {
    const m = /([^/:]+?)(?:\.git)?\/?$/.exec(effectiveUrl);
    return m ? m[1] : '';
  }, [effectiveUrl]);
  const targetDir = dirTouched ? directory : directory && repoName ? `${directory.replace(/[\\/]+$/, '')}${settings ? (window.gitgoodBridge.platform === 'win32' ? '\\' : '/') : '/'}${repoName}` : directory;

  const chooseDir = async () => {
    const chosen = await invoke('app.chooseDirectory', { title: 'Choose where to clone', defaultPath: directory || undefined });
    if (chosen) {
      setDirectory(chosen);
      setDirTouched(true);
    }
  };

  const clone = async () => {
    if (!effectiveUrl || !targetDir) return;
    setCloning(true);
    setError(null);
    try {
      const repo = await invoke('repos.clone', { url: effectiveUrl, directory: targetDir, branch: null });
      closeDialog();
      await actions.openRepository(repo);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCloning(false);
    }
  };

  return (
    <Dialog
      title="Clone a repository"
      icon="download"
      onClose={closeDialog}
      width="wide"
      dismissible={!cloning}
      footer={
        <>
          {cloning && progress ? (
            <span className="left muted">
              <Spinner /> {progress.description}
            </span>
          ) : null}
          <Button onClick={closeDialog} disabled={cloning}>Cancel</Button>
          <Button variant="primary" onClick={() => void clone()} disabled={!effectiveUrl || !targetDir} loading={cloning}>Clone</Button>
        </>
      }
    >
      <div className="dialog-tabs" style={{ margin: '-16px -16px 16px', padding: '0 16px' }}>
        <button type="button" className={tab === 'github' ? 'active' : ''} onClick={() => setTab('github')}>GitHub.com</button>
        <button type="button" className={tab === 'url' ? 'active' : ''} onClick={() => setTab('url')}>URL</button>
      </div>
      {tab === 'github' ? (
        !account ? (
          <Callout tone="info">
            Sign in to GitHub to browse your repositories.{' '}
            <Button size="sm" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in</Button>
          </Callout>
        ) : (
          <div className="repo-list-clone" style={{ marginBottom: 12 }}>
            <div className="popover-header">
              <FilterInput value={query} onChange={setQuery} placeholder="Filter your repositories" autoFocus />
              <Button iconOnly icon="sync" variant="ghost" title="Refresh" onClick={() => void loadRepos()} disabled={loadingRepos} />
            </div>
            <div className="popover-list" style={{ maxHeight: 'none' }}>
              {loadingRepos ? (
                <div className="list-empty">
                  <Spinner /> Loading repositories…
                </div>
              ) : reposError ? (
                <div className="list-empty">{reposError}</div>
              ) : !filtered.length ? (
                <div className="list-empty">No repositories found.</div>
              ) : (
                grouped.map(([owner, list]) => (
                  <React.Fragment key={owner}>
                    <div className="list-group-header">{owner}</div>
                    {list.map((r) => (
                      <div key={r.nameWithOwner} className={`list-row ${selected?.nameWithOwner === r.nameWithOwner ? 'selected' : ''}`} onClick={() => setSelected(r)} onDoubleClick={() => void clone()}>
                        {r.ownerAvatar ? <span className="avatar" style={{ width: 18, height: 18 }}><img src={r.ownerAvatar} alt="" referrerPolicy="no-referrer" /></span> : <Icon name={r.isPrivate ? 'lock' : 'repo'} />}
                        <span className="row-main">
                          <span className="truncate">{r.name} {r.isPrivate ? <Icon name="lock" size={11} className="muted" /> : null} {r.isFork ? <span className="badge">fork</span> : null}</span>
                          {r.description ? <span className="row-sub truncate">{r.description}</span> : null}
                        </span>
                      </div>
                    ))}
                  </React.Fragment>
                ))
              )}
            </div>
          </div>
        )
      ) : (
        <TextField label="Repository URL or GitHub username and repository" placeholder="https://github.com/owner/repo.git or owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} />
      )}
      <TextField label="Local path" value={targetDir} onChange={(e) => { setDirectory(e.target.value); setDirTouched(true); }} trailing={<Button onClick={() => void chooseDir()}>Choose…</Button>} spellCheck={false} />
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// New repository
// ---------------------------------------------------------------------------

export function NewRepoDialog(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [directory, setDirectory] = useState(settings?.defaultCloneDirectory ?? '');
  const [readme, setReadme] = useState(true);
  const [gitignore, setGitignore] = useState<string>('');
  const [license, setLicense] = useState<string>('');
  const [templates, setTemplates] = useState<string[]>([]);
  const [licenses, setLicenses] = useState<{ key: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ghInstalled = useAppStore((s) => s.tools?.gh.installed ?? false);

  useEffect(() => {
    if (!ghInstalled) return;
    void invoke('gh.gitignoreTemplates').then(setTemplates).catch(() => undefined);
    void invoke('gh.licenses').then(setLicenses).catch(() => undefined);
  }, [ghInstalled]);

  const create = async () => {
    if (!name.trim() || !directory.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await invoke('repos.create', { name: name.trim(), directory, description, initializeWithReadme: readme, gitignoreTemplate: gitignore || null, license: license || null });
      closeDialog();
      await actions.openRepository(repo);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Create a new repository"
      icon="repo"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!name.trim() || !directory.trim()} loading={busy}>Create repository</Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} hint={name && /[\s/\\:*?"<>|]/.test(name) ? 'Avoid spaces and special characters in folder names.' : undefined} />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <TextField
        label="Local path"
        value={directory}
        onChange={(e) => setDirectory(e.target.value)}
        spellCheck={false}
        trailing={
          <Button
            onClick={() => void invoke('app.chooseDirectory', { title: 'Choose parent folder', defaultPath: directory || undefined }).then((d) => d && setDirectory(d))}
          >
            Choose…
          </Button>
        }
        hint={name ? `Repository will be created at ${directory.replace(/[\\/]+$/, '')}${window.gitgoodBridge.platform === 'win32' ? '\\' : '/'}${name}` : undefined}
      />
      <Checkbox checked={readme} onChange={setReadme} label="Initialize this repository with a README" />
      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="field">
          <label>Git ignore</label>
          <select value={gitignore} onChange={(e) => setGitignore(e.target.value)}>
            <option value="">None</option>
            {templates.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>License</label>
          <select value={license} onChange={(e) => setLicense(e.target.value)}>
            <option value="">None</option>
            {licenses.map((l) => (
              <option key={l.key} value={l.key}>{l.name}</option>
            ))}
          </select>
        </div>
      </div>
      {!ghInstalled ? <Callout tone="info">Install the GitHub CLI to choose .gitignore and license templates.</Callout> : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add existing repository
// ---------------------------------------------------------------------------

export function AddRepoDialog(): React.JSX.Element {
  const [path, setPath] = useState('');
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!path.trim()) {
      setIsRepo(null);
      return;
    }
    const t = setTimeout(() => void invoke('app.isRepository', path.trim()).then(setIsRepo).catch(() => setIsRepo(false)), 250);
    return () => clearTimeout(t);
  }, [path]);
  const add = async () => {
    setBusy(true);
    await actions.addLocalRepository(path.trim());
    setBusy(false);
  };
  return (
    <Dialog
      title="Add local repository"
      icon="folder"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void add()} disabled={!path.trim() || isRepo === false} loading={busy}>Add repository</Button>
        </>
      }
    >
      <TextField
        label="Local path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        autoFocus
        spellCheck={false}
        trailing={<Button onClick={() => void invoke('app.chooseDirectory', { title: 'Choose a repository folder' }).then((d) => d && setPath(d))}>Choose…</Button>}
        error={isRepo === false ? 'This folder is not a Git repository.' : undefined}
      />
      {isRepo === false ? (
        <Callout tone="info">
          Would you like to <Button variant="link" onClick={() => { closeDialog(); openDialog({ kind: 'new-repo' }); }}>create a repository</Button> here instead?
        </Callout>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Remove repository
// ---------------------------------------------------------------------------

export function RemoveRepoDialog({ repo }: { repo: RepositoryInfo }): React.JSX.Element {
  const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const worktrees = useAppStore((s) => s.repos.filter((r) => r.worktreeOf === repo.id));
  return (
    <Dialog
      title="Remove repository"
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={async () => { setBusy(true); await actions.removeRepository(repo, trash); closeDialog(); }}>Remove</Button>
        </>
      }
    >
      <p>
        Remove <strong>{repo.alias ?? repo.name}</strong> from GitGood? The repository stays on disk unless you also move it to the {window.gitgoodBridge.platform === 'win32' ? 'Recycle Bin' : 'Trash'}.
      </p>
      <p className="mono muted" style={{ fontSize: 12 }}>{repo.path}</p>
      {worktrees.length ? (
        <Callout tone="warning">
          This repository has {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'} in the list ({worktrees.map((w) => w.alias ?? w.name).join(', ')}). They will be removed from the list too; their directories are left untouched.
        </Callout>
      ) : null}
      <Checkbox checked={trash} onChange={setTrash} label={`Also move this repository to the ${window.gitgoodBridge.platform === 'win32' ? 'Recycle Bin' : 'Trash'}`} />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Publish repository to GitHub
// ---------------------------------------------------------------------------

export function PublishDialog(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  const [name, setName] = useState(repo?.name ?? '');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [org, setOrg] = useState('');
  const [orgs, setOrgs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (account) void invoke('gh.orgs.list').then(setOrgs).catch(() => undefined);
  }, [account]);
  const publish = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const ref = await invoke('gh.repo.publish', repo.path, { name: name.trim(), description, isPrivate, organization: org || null });
      closeDialog();
      actions.showToast({ kind: 'success', title: `Published to ${ref.owner}/${ref.name}`, action: { label: 'View on GitHub', onClick: () => void actions.openExternal(ref.url) } });
      await actions.refreshAll();
      store.set((s) => ({ currentRepo: s.currentRepo ? { ...s.currentRepo, github: ref } : null }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!account) {
    return (
      <Dialog title="Publish repository" icon="upload" onClose={closeDialog} footer={<Button onClick={closeDialog}>Close</Button>}>
        <Callout tone="info">
          Sign in to GitHub to publish this repository. <Button size="sm" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in</Button>
        </Callout>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Publish repository"
      icon="upload"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void publish()} disabled={!name.trim()} loading={busy}>Publish repository</Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <Checkbox checked={isPrivate} onChange={setPrivate} label="Keep this code private" />
      <div className="field" style={{ marginTop: 12 }}>
        <label>Organization</label>
        <select value={org} onChange={(e) => setOrg(e.target.value)}>
          <option value="">{account.login} (personal account)</option>
          {orgs.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Repository settings
// ---------------------------------------------------------------------------

export function RepoSettingsDialog({ tab: initialTab }: { tab?: RepoSettingsTab }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const remotes = useAppStore((s) => s.remotes);
  const [tab, setTab] = useState<RepoSettingsTab>(initialTab ?? 'remote');
  const origin = remotes.find((r) => r.name === 'origin');
  const [remoteUrl, setRemoteUrl] = useState(origin?.fetchUrl ?? '');
  const [ignore, setIgnore] = useState<string | null>(null);
  const [alias, setAlias] = useState(repo?.alias ?? '');
  const [identity, setIdentity] = useState<{ useLocal: boolean; name: string; email: string; globalName: string; globalEmail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    void invoke('repo.gitignore.read', repo.path).then(setIgnore).catch(() => setIgnore(''));
    void invoke('repo.config', repo.path).then((c) => setIdentity({ useLocal: !!(c.local.name || c.local.email), name: c.local.name ?? c.global.name ?? '', email: c.local.email ?? c.global.email ?? '', globalName: c.global.name ?? '', globalEmail: c.global.email ?? '' })).catch(() => undefined);
  }, [repo]);

  const save = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      if (remoteUrl.trim() !== (origin?.fetchUrl ?? '')) {
        if (origin) await invoke('repo.remote.set', repo.path, 'origin', remoteUrl.trim());
        else if (remoteUrl.trim()) await invoke('repo.remote.add', repo.path, 'origin', remoteUrl.trim());
      }
      if (ignore !== null) await invoke('repo.gitignore.write', repo.path, ignore);
      if (identity) {
        if (identity.useLocal) await invoke('repo.config.setIdentity', repo.path, 'local', identity.name, identity.email);
        else await invoke('repo.config.unsetLocalIdentity', repo.path);
      }
      await invoke('repos.setAlias', repo.id, alias.trim() || null);
      closeDialog();
      await actions.refreshAll();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Repository settings — ${repo?.name ?? ''}`}
      icon="gear"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>Save</Button>
        </>
      }
    >
      <div className="dialog-tabs" style={{ margin: '-16px -16px 16px', padding: '0 16px' }}>
        {(['remote', 'ignored', 'identity', 'alias'] as RepoSettingsTab[]).map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'remote' ? 'Remote' : t === 'ignored' ? 'Ignored files' : t === 'identity' ? 'Git config' : 'Name'}
          </button>
        ))}
      </div>
      {tab === 'remote' ? (
        <>
          <TextField label="Primary remote repository (origin)" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" spellCheck={false} />
          {remotes.filter((r) => r.name !== 'origin').length ? (
            <div className="field">
              <label>Other remotes</label>
              {remotes.filter((r) => r.name !== 'origin').map((r) => (
                <div key={r.name} className="field-row" style={{ fontSize: 12 }}>
                  <span className="mono" style={{ flex: '0 0 80px' }}>{r.name}</span>
                  <span className="mono truncate" style={{ flex: 1 }}>{r.fetchUrl}</span>
                  <Button size="sm" variant="danger" onClick={() => repo && void invoke('repo.remote.remove', repo.path, r.name).then(() => actions.refreshRemotes())}>Remove</Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {tab === 'ignored' ? (
        <div className="field">
          <label>Ignored files (.gitignore)</label>
          <textarea className="mono" rows={14} value={ignore ?? ''} onChange={(e) => setIgnore(e.target.value)} spellCheck={false} style={{ fontSize: 12 }} />
          <span className="hint">One pattern per line. Changes are saved to the .gitignore file at the repository root.</span>
        </div>
      ) : null}
      {tab === 'identity' && identity ? (
        <>
          <label className="radio-option">
            <input type="radio" checked={!identity.useLocal} onChange={() => setIdentity({ ...identity, useLocal: false })} />
            <span>
              <strong>Use my global Git config</strong>
              <span>{identity.globalName || '(no name)'} &lt;{identity.globalEmail || 'no email'}&gt;</span>
            </span>
          </label>
          <label className="radio-option">
            <input type="radio" checked={identity.useLocal} onChange={() => setIdentity({ ...identity, useLocal: true })} />
            <span>
              <strong>Use a local Git config for this repository</strong>
              <span>Commits in this repository will use the name and email below.</span>
            </span>
          </label>
          {identity.useLocal ? (
            <div className="form-grid">
              <TextField label="Name" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
              <TextField label="Email" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} />
            </div>
          ) : null}
        </>
      ) : null}
      {tab === 'alias' ? <TextField label="Repository alias" hint="Shown in the repository list instead of the folder name." value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={repo?.name} /> : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

export function useAccountAvatar(): React.JSX.Element | null {
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);
  return account ? <Avatar email={`${account.login}@users.noreply.github.com`} name={account.name ?? account.login} size={32} /> : null;
}
