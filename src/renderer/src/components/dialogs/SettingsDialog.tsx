import React, { useEffect, useState } from 'react';
import { watchedFolderLabel, type AiFeature, type AiUsageMonth, type AppSettings, type FoundEditor, type FoundShell, type RepositoryScanProgress, type SigningConfig, type SigningConfigInfo, type SigningKey, type WatchedFolderProblem, type WatchedFolderStatus } from '@shared/types';
import { errorMessage, invoke, isMac, on, platform } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, store, useAppStore, type SettingsTab } from '../../state/store';
import { modelFor } from '@shared/ai-model';
import { acceleratorFromEvent, findConflict, formatAccelerator, mergeShortcuts, setShortcut, SHORTCUT_CATEGORIES, SHORTCUTS, type ShortcutConflict, type ShortcutOverrides } from '@shared/shortcuts';
import { AGENT_PRESETS, agentTemplate, quotingFor, validateAgentTemplate } from '@shared/agent-presets';
import { Avatar, Button, Callout, Checkbox, Dialog, FilterInput, Icon, Spinner, TextField, type IconName } from '../ui';
import { LinkifiedText } from './IssueDialogs';
import { SettingsSyncCard } from './SettingsSyncDialogs';

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'github' },
  { id: 'integrations', label: 'Integrations', icon: 'terminal' },
  { id: 'git', label: 'Git', icon: 'commit' },
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
  { id: 'prompts', label: 'Prompts', icon: 'info' },
  { id: 'ai', label: 'AI', icon: 'sparkle' },
  { id: 'advanced', label: 'Advanced', icon: 'gear' },
];

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (recommended)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (fast)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest)' },
];

export function SettingsDialog({ tab: initialTab }: { tab?: SettingsTab }): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'accounts');
  const settings = useAppStore((s) => s.settings);
  if (!settings) return <></>;
  const update = (patch: Partial<AppSettings>) => void actions.updateSettings(patch);
  return (
    <Dialog title="Options" icon="gear" onClose={closeDialog} width="wide" className="settings-dialog" footer={<Button variant="primary" onClick={closeDialog}>Done</Button>}>
      <div className="settings-layout" style={{ margin: -16 }}>
        <nav className="settings-nav">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'accounts' ? <AccountsTab /> : null}
          {tab === 'integrations' ? <IntegrationsTab settings={settings} update={update} /> : null}
          {tab === 'git' ? <GitTab settings={settings} update={update} /> : null}
          {tab === 'appearance' ? <AppearanceTab settings={settings} update={update} /> : null}
          {tab === 'prompts' ? <PromptsTab settings={settings} update={update} /> : null}
          {tab === 'ai' ? <AiTab settings={settings} update={update} /> : null}
          {tab === 'advanced' ? <AdvancedTab settings={settings} update={update} /> : null}
        </div>
      </div>
    </Dialog>
  );
}

function AccountsTab(): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const account = tools?.ghAccount ?? null;
  const accounts = tools?.ghAccounts ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    await fn();
    setBusy(null);
  };
  const ghMissing = !!tools && !tools.gh.installed && !tools.gh.pending;
  return (
    <>
      <h3>GitHub accounts</h3>
      {account ? (
        <>
          {accounts.map((a) => {
            const key = `${a.host}/${a.login}`;
            const profile = a.host === account.host && a.login === account.login ? account : null;
            return (
              <div key={key} className="account-card" style={{ marginBottom: 8 }}>
                <Avatar email={`${a.login}@users.noreply.github.com`} name={profile?.name ?? a.login} size={40} />
                <span className="who">
                  <strong>{profile?.name ?? a.login}</strong>
                  <span className="muted">@{a.login} · {a.host}{a.active ? ' · active' : ''}</span>
                  <span className="muted" style={{ fontSize: 12 }}>Scopes: {a.scopes.join(', ') || 'unknown'} · Git protocol: {a.protocol ?? 'https'}</span>
                </span>
                {!a.active ? <Button loading={busy === `switch:${key}`} onClick={() => void run(`switch:${key}`, () => actions.switchAccount(a.host, a.login))} title="Use this account by default. Repositories with their own account are unaffected.">Make active</Button> : null}
                <Button loading={busy === `out:${key}`} onClick={() => void run(`out:${key}`, () => actions.signOut(a.host, a.login))}>Sign out</Button>
              </div>
            );
          })}
          <Button icon="github" onClick={() => openDialog({ kind: 'sign-in' })} disabled={ghMissing}>Add another account</Button>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>The active account is used for every repository unless you choose one for it in Repository settings → GitHub account.</p>
          {tools && !tools.credentialHelperConfigured ? (
            <Callout tone="warning">
              Git is not configured to use the GitHub CLI for authentication, so pushes to private repositories may fail.{' '}
              <Button size="sm" onClick={() => void invoke('gh.auth.setupGit').then(() => actions.refreshTools()).catch((e) => actions.showError('Setup failed', e))}>Configure Git credentials</Button>
            </Callout>
          ) : (
            <Callout tone="success">Git uses your GitHub CLI credentials for HTTPS remotes.</Callout>
          )}
        </>
      ) : (
        <>
          <p className="muted">Sign in to clone your repositories, open pull requests and push over HTTPS without managing tokens.</p>
          <Button variant="primary" icon="github" onClick={() => openDialog({ kind: 'sign-in' })} disabled={ghMissing}>Sign in to GitHub.com</Button>
          {tools?.gh.pending ? <p className="muted"><Spinner /> Checking for the GitHub CLI…</p> : null}
          {ghMissing ? <Callout tone="warning">Install the GitHub CLI first (see the Advanced tab).</Callout> : null}
          {tools?.ghAuthError ? <Callout tone="danger">{tools.ghAuthError}</Callout> : null}
        </>
      )}
    </>
  );
}

function IntegrationsTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const [editors, setEditors] = useState<FoundEditor[] | null>(null);
  const [shells, setShells] = useState<FoundShell[] | null>(null);
  useEffect(() => {
    void invoke('app.editors').then(setEditors).catch(() => setEditors([]));
    void invoke('app.shells').then(setShells).catch(() => setShells([]));
  }, []);
  return (
    <>
      <h3>External editor</h3>
      <div className="settings-row">
        <label>Editor</label>
        {editors === null ? (
          <Spinner />
        ) : (
          <select value={settings.externalEditor ?? ''} onChange={(e) => update({ externalEditor: e.target.value || null })}>
            <option value="">{editors.length ? `Default (${editors[0].name})` : 'None found'}</option>
            {editors.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        )}
      </div>
      {settings.externalEditor === 'custom' ? (
        <TextField label="Editor executable" value={settings.customEditorPath ?? ''} onChange={(e) => update({ customEditorPath: e.target.value })} trailing={<Button onClick={() => void invoke('app.chooseFile', { title: 'Choose editor' }).then((p) => p && update({ customEditorPath: p }))}>Browse…</Button>} />
      ) : null}
      <h3 style={{ marginTop: 20 }}>Shell</h3>
      <div className="settings-row">
        <label>Terminal</label>
        {shells === null ? (
          <Spinner />
        ) : (
          <select value={settings.shell ?? ''} onChange={(e) => update({ shell: e.target.value || null })}>
            <option value="">{shells.length ? `Default (${shells[0].name})` : 'None found'}</option>
            {shells.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        )}
      </div>
      {settings.shell === 'custom' ? <TextField label="Terminal executable" value={settings.customShellPath ?? ''} onChange={(e) => update({ customShellPath: e.target.value })} trailing={<Button onClick={() => void invoke('app.chooseFile', { title: 'Choose terminal' }).then((p) => p && update({ customShellPath: p }))}>Browse…</Button>} /> : null}
    </>
  );
}

function GitTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const repo = useAppStore((s) => s.currentRepo);
  useEffect(() => {
    void invoke('repo.config', repo?.path ?? '')
      .then((c) => {
        setName(c.global.name ?? '');
        setEmail(c.global.email ?? '');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [repo]);
  return (
    <>
      <h3>Git config (global)</h3>
      {!loaded ? <Spinner /> : null}
      <div className="form-grid">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <Button onClick={() => void invoke('repo.config.setIdentity', null, 'global', name, email).then(() => setSaved(true)).catch((e) => actions.showError('Could not save', e))} disabled={!name.trim() || !email.trim()}>Save</Button>
      {saved ? <span className="muted" style={{ marginLeft: 8 }}>Saved</span> : null}
      <p className="muted" style={{ fontSize: 12 }}>Tip: use your GitHub-provided noreply email to keep your address private and still get commits attributed to you.</p>
      <h4>Default clone location</h4>
      <TextField value={settings.defaultCloneDirectory} onChange={(e) => update({ defaultCloneDirectory: e.target.value })} trailing={<Button onClick={() => void invoke('app.chooseDirectory', { title: 'Choose default clone location' }).then((d) => d && update({ defaultCloneDirectory: d }))}>Choose…</Button>} />
      <h4>Default worktree location</h4>
      <TextField
        value={settings.defaultWorktreeDirectory}
        onChange={(e) => update({ defaultWorktreeDirectory: e.target.value })}
        placeholder="Leave empty for a sibling of the repository"
        trailing={<Button onClick={() => void invoke('app.chooseDirectory', { title: 'Choose default worktree location' }).then((d) => d && update({ defaultWorktreeDirectory: d }))}>Choose…</Button>}
      />
      <WatchedFoldersCard settings={settings} update={update} />
      <h4>Pull behavior</h4>
      <div className="settings-row">
        <label htmlFor="settings-pull-behavior">When pulling</label>
        <select id="settings-pull-behavior" value={settings.pullBehavior} onChange={(e) => update({ pullBehavior: e.target.value as AppSettings['pullBehavior'] })}>
          <option value="git-config">Follow Git config (pull.rebase)</option>
          <option value="merge">Merge remote changes</option>
          <option value="rebase">Rebase local commits on top</option>
        </select>
      </div>
      <h4>Background fetch</h4>
      <div className="settings-row">
        <label htmlFor="settings-fetch-interval">Fetch every</label>
        <select id="settings-fetch-interval" value={settings.autoFetchIntervalMinutes} onChange={(e) => update({ autoFetchIntervalMinutes: Number(e.target.value) })}>
          <option value={0}>Never</option>
          <option value={5}>5 minutes</option>
          <option value={10}>10 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
        </select>
      </div>
      <h4>Repository health</h4>
      <div className="settings-row">
        <label htmlFor="settings-stale-branch-days">A branch is inactive after</label>
        <input id="settings-stale-branch-days" type="number" min={1} max={3650} value={settings.staleBranchDays} onChange={(e) => update({ staleBranchDays: Math.max(1, Number(e.target.value) || 90) })} style={{ flex: '0 0 80px' }} /> days without a commit
      </div>
      <div className="settings-row">
        <label htmlFor="settings-large-file-threshold">Warn about blobs at or above</label>
        <input
          id="settings-large-file-threshold"
          type="number"
          min={1}
          max={2048}
          value={Math.round(settings.healthLargeFileThresholdBytes / (1024 * 1024))}
          onChange={(e) => update({ healthLargeFileThresholdBytes: Math.max(1, Number(e.target.value) || 5) * 1024 * 1024 })}
          style={{ flex: '0 0 80px' }}
        />{' '}
        MB
      </div>
      <h4>History</h4>
      <Checkbox checked={settings.historyVerifySignatures} onChange={(v) => update({ historyVerifySignatures: v })} label="Verify commit signatures in History (shown as badges; slower on large histories)" />
      <Checkbox checked={settings.historyGraph} onChange={(v) => update({ historyGraph: v })} label="Show the commit graph in History (branch lanes; hidden while searching or filtering)" />
      <SigningSection />
    </>
  );
}

function SigningSection(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const tools = useAppStore((s) => s.tools);
  const [info, setInfo] = useState<SigningConfigInfo | null>(null);
  const [scope, setScope] = useState<'local' | 'global'>(repo ? 'local' : 'global');
  const [format, setFormat] = useState<'off' | 'openpgp' | 'ssh'>('off');
  const [key, setKey] = useState('');
  const [allowedSignersFile, setAllowedSignersFile] = useState('');
  const [signCommits, setSignCommits] = useState(false);
  const [signTags, setSignTags] = useState(false);
  const [keys, setKeys] = useState<SigningKey[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = () => {
    void invoke('repo.signing.get', repo?.path ?? '')
      .then((i) => {
        setInfo(i);
        const source = repo && scope === 'local' ? i.local : i.global;
        setFormat(source.format === 'openpgp' ? 'openpgp' : source.format === 'ssh' ? 'ssh' : 'off');
        setKey(source.key ?? '');
        setAllowedSignersFile(source.allowedSignersFile ?? '');
        setSignCommits(source.signCommits);
        setSignTags(source.signTags);
      })
      .catch(() => undefined);
  };
  useEffect(load, [repo, scope]);

  const detectKeys = async () => {
    if (format === 'off') return;
    setDetecting(true);
    setKeys(null);
    try {
      setKeys(await invoke('app.signing.keys', format, null));
    } catch (err) {
      actions.showError('Could not list signing keys', err);
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const patch: Partial<SigningConfig> =
        format === 'off'
          ? { signCommits: false, signTags: false }
          : { format, key: key.trim() || null, signCommits, signTags, ...(format === 'ssh' ? { allowedSignersFile: allowedSignersFile.trim() || null } : {}) };
      await invoke('repo.signing.set', scope === 'local' ? (repo?.path ?? null) : null, scope, patch);
      load();
      actions.bumpSigningConfigVersion();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!repo) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await invoke('app.signing.test', repo.path));
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const gpgMissing = format === 'openpgp' && tools && !tools.gpg.installed;
  const installHint = window.gitgoodBridge.platform === 'win32' ? 'winget install GnuPG.GnuPG' : isMac ? 'brew install gnupg' : 'sudo apt install gnupg';

  return (
    <>
      <h3>Commit signing</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        GitGood never reads or prompts for a passphrase; it only configures and tests signing. A graphical pinentry or a running agent with the passphrase already unlocked is needed to actually sign.
      </p>
      {repo ? (
        <div className="settings-row">
          <label>Scope</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'local' | 'global')}>
            <option value="local">This repository</option>
            <option value="global">Global (all repositories)</option>
          </select>
        </div>
      ) : null}
      <div className="settings-row">
        <label>Format</label>
        <select
          value={format}
          onChange={(e) => {
            setFormat(e.target.value as typeof format);
            setKeys(null);
            setTestResult(null);
          }}
        >
          <option value="off">Off</option>
          <option value="openpgp">GPG</option>
          <option value="ssh">SSH</option>
        </select>
      </div>
      {format !== 'off' ? (
        <>
          <div className="settings-row">
            <label>Key</label>
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder={format === 'openpgp' ? 'GPG key id' : 'Path to a public key file, or paste a public key'} spellCheck={false} />
            <Button size="sm" loading={detecting} onClick={() => void detectKeys()} disabled={!!gpgMissing}>Detect keys</Button>
            {format === 'ssh' ? <Button size="sm" onClick={() => void invoke('app.chooseFile', { title: 'Choose SSH public key' }).then((p) => p && setKey(p))}>Browse…</Button> : null}
          </div>
          {gpgMissing ? (
            <Callout tone="warning">
              GPG was not found, so keys cannot be detected. Install it: <span className="mono">{installHint}</span>
            </Callout>
          ) : null}
          {keys ? (
            keys.length ? (
              <div className="file-preview-list">
                {keys.map((k) => (
                  <div key={k.id}>
                    <button type="button" className="btn link" onClick={() => setKey(k.id)}>
                      {k.label}
                    </button>
                    {k.expires ? ` (expires ${new Date(k.expires).toLocaleDateString()})` : ''}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 12 }}>No keys found.</p>
            )
          ) : null}
          <Checkbox checked={signCommits} onChange={setSignCommits} label="Sign all commits" />
          <Checkbox checked={signTags} onChange={setSignTags} label="Sign all tags" />
          {format === 'ssh' ? (
            <div className="settings-row">
              <label>Allowed signers file</label>
              <input value={allowedSignersFile} onChange={(e) => setAllowedSignersFile(e.target.value)} placeholder="Needed to verify SSH signatures locally (History badges)" spellCheck={false} />
              <Button size="sm" onClick={() => void invoke('app.chooseFile', { title: 'Choose allowed-signers file' }).then((p) => p && setAllowedSignersFile(p))}>Browse…</Button>
            </div>
          ) : null}
        </>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <Button variant="primary" loading={saving} onClick={() => void save()}>Save</Button>
        {repo ? (
          <Button loading={testing} onClick={() => void test()} disabled={format === 'off' || !key.trim()}>
            Test signing
          </Button>
        ) : null}
      </div>
      {saveError ? <Callout tone="danger">{saveError}</Callout> : null}
      {testResult ? <Callout tone={testResult.ok ? 'success' : 'warning'}>{testResult.message}</Callout> : null}
      {info?.global.format && repo && scope === 'local' && info.local.format === null ? (
        <p className="muted" style={{ fontSize: 12 }}>
          Global signing is configured ({info.global.format}); this repository will use it unless overridden here.
        </p>
      ) : null}
    </>
  );
}

const FOLDER_PROBLEM_TEXT: Record<WatchedFolderProblem, string> = {
  missing: 'This folder no longer exists.',
  'not-a-directory': 'This path is not a folder.',
  unreadable: 'This folder could not be read (check its permissions).',
};

/**
 * Watched folders: registered folders, their scan depth, the scan controls and
 * the exclusion list. Paths here are machine-local and never leave the machine
 * through a settings export, which the copy states so it is not a surprise.
 */
function WatchedFoldersCard({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const folders = settings.watchedFolders;
  const [statuses, setStatuses] = useState<WatchedFolderStatus[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<RepositoryScanProgress | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const refresh = React.useCallback(() => {
    void invoke('repos.watchedFolders.status').then(setStatuses).catch(() => setStatuses([]));
    void invoke('repos.exclusions.list').then(setExclusions).catch(() => setExclusions([]));
  }, []);

  useEffect(refresh, [refresh, folders]);

  useEffect(() => on('repos.scanProgress', (p) => setProgress(p.folder ? p : null)), []);

  const problemFor = (path: string): WatchedFolderProblem | null => statuses.find((s) => s.path === path)?.problem ?? null;

  const addFolder = async (): Promise<void> => {
    const chosen = await invoke('app.chooseDirectory', { title: 'Choose a folder to watch for repositories' });
    if (!chosen) return;
    setError(null);
    const result = await invoke('repos.watchedFolders.add', chosen);
    if (!result.ok) setError(result.error ?? 'That folder could not be added.');
    refresh();
  };

  const scan = async (): Promise<void> => {
    setScanning(true);
    setSummary(null);
    setError(null);
    try {
      const result = await invoke('repos.scanWatchedFolders');
      setSummary(actions.describeScanResult(result));
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  return (
    <>
      <h4>Watched folders</h4>
      <p className="muted" style={{ fontSize: 12 }}>
        Every Git repository inside these folders is added automatically. Folders are scanned when GitGood starts, when you change them here, and when you choose Rescan now — not continuously, so a repository cloned elsewhere appears after the next scan. These paths stay on this computer and are never part of a settings export.
      </p>
      {folders.length ? (
        <div className="watched-folders">
          {folders.map((folder, index) => {
            const problem = problemFor(folder.path);
            return (
              <div key={folder.path} className="watched-folder-row">
                <div className="watched-folder-path">
                  {/* The folder as the user chose it; the tooltip names where it actually resolves, which is the path scans and exclusions work in. */}
                  <span className="mono" title={folder.displayPath ? `${folder.displayPath} → ${folder.path}` : folder.path}>{watchedFolderLabel(folder)}</span>
                  {problem ? <span className="muted" style={{ fontSize: 12 }}>{FOLDER_PROBLEM_TEXT[problem]}</span> : null}
                </div>
                <label className="muted" style={{ fontSize: 12 }}>
                  Depth
                  <select
                    value={folder.depth}
                    style={{ marginLeft: 6 }}
                    onChange={(e) => update({ watchedFolders: folders.map((f, i) => (i === index ? { ...f, depth: Number(e.target.value) } : f)) })}
                  >
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <Button size="sm" onClick={() => update({ watchedFolders: folders.filter((_, i) => i !== index) })}>Remove</Button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>No folders are watched yet.</p>
      )}
      <div className="settings-row" style={{ gap: 8 }}>
        <Button onClick={() => void addFolder()}>Add folder…</Button>
        <Button onClick={() => void scan()} disabled={!folders.length} loading={scanning}>Rescan now</Button>
        {scanning ? <Button onClick={() => void invoke('repos.cancelScan')}>Cancel</Button> : null}
        {scanning && progress ? (
          <span className="muted" style={{ fontSize: 12 }}>
            {progress.found} found · {progress.scanned} folders checked
          </span>
        ) : null}
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {summary && !scanning ? <Callout tone="info">{summary}</Callout> : null}
      {exclusions.length ? (
        <>
          <h4>Not added again</h4>
          <p className="muted" style={{ fontSize: 12 }}>
            Repositories you removed while they were inside a watched folder. Scans skip them until you remove them from this list.
          </p>
          <div className="watched-folders">
            {exclusions.map((path) => (
              <div key={path} className="watched-folder-row">
                <span className="mono watched-folder-path" title={path}>{path}</span>
                <Button size="sm" onClick={() => void invoke('repos.exclusions.remove', path).then(setExclusions)}>Remove from list</Button>
              </div>
            ))}
          </div>
          <Button size="sm" onClick={() => void invoke('repos.exclusions.clear').then(setExclusions)}>Clear all</Button>
        </>
      ) : null}
    </>
  );
}

function AppearanceTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  return (
    <>
      <h3>Theme</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['system', 'light', 'dark'] as const).map((t) => (
          <Button key={t} variant={settings.theme === t ? 'accent' : 'default'} onClick={() => update({ theme: t })}>
            {t === 'system' ? 'Follow system' : t === 'light' ? 'Light' : 'Dark'}
          </Button>
        ))}
      </div>
      <h4>Diff</h4>
      <div className="settings-row">
        <label htmlFor="settings-diff-view-mode">Default view</label>
        <select id="settings-diff-view-mode" value={settings.diffViewMode} onChange={(e) => update({ diffViewMode: e.target.value as 'unified' | 'split' })}>
          <option value="unified">Unified</option>
          <option value="split">Split (side by side)</option>
        </select>
      </div>
      <div className="settings-row">
        <label htmlFor="settings-diff-font-size">Font size</label>
        <input id="settings-diff-font-size" type="number" min={9} max={24} value={settings.diffFontSize} onChange={(e) => update({ diffFontSize: Math.max(9, Math.min(24, Number(e.target.value) || 12)) })} style={{ flex: '0 0 80px' }} />
      </div>
      <Checkbox checked={settings.diffSyntaxHighlighting} onChange={(v) => update({ diffSyntaxHighlighting: v })} label="Syntax highlighting" />
      <Checkbox checked={settings.diffShowIntraline} onChange={(v) => update({ diffShowIntraline: v })} label="Highlight word-level changes within modified lines" />
      <Checkbox checked={settings.diffWrapLines} onChange={(v) => update({ diffWrapLines: v })} label="Wrap long lines" />
      <Checkbox checked={settings.diffHideWhitespace} onChange={(v) => update({ diffHideWhitespace: v })} label="Hide whitespace-only changes" />
      <h4>Blame</h4>
      <Checkbox checked={settings.blameIgnoreWhitespace} onChange={(v) => update({ blameIgnoreWhitespace: v })} label="Ignore whitespace-only commits when attributing blame" />
      <h4>Lists</h4>
      <Checkbox checked={settings.repositoryIndicators} onChange={(v) => update({ repositoryIndicators: v })} label="Show ahead/behind and change indicators in the repository list" />
      <Checkbox checked={settings.showUnpushedWorkIndicator} onChange={(v) => update({ showUnpushedWorkIndicator: v })} label="Show a warning dot on repositories with unpushed work" />
      <Checkbox checked={settings.showCommitLengthWarning} onChange={(v) => update({ showCommitLengthWarning: v })} label="Warn when a commit summary is longer than 72 characters" />
    </>
  );
}

function PromptsTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  return (
    <>
      <h3>Show a confirmation dialog before…</h3>
      <Checkbox checked={settings.confirmRepositoryRemoval} onChange={(v) => update({ confirmRepositoryRemoval: v })} label="Removing repositories" />
      <Checkbox checked={settings.confirmDiscardChanges} onChange={(v) => update({ confirmDiscardChanges: v })} label="Discarding changes" />
      <Checkbox checked={settings.confirmDiscardChangesPermanently} onChange={(v) => update({ confirmDiscardChangesPermanently: v })} label={`Move discarded files to the ${window.gitgoodBridge.platform === 'win32' ? 'Recycle Bin' : 'Trash'} (uncheck to delete permanently)`} />
      <Checkbox checked={settings.confirmDiscardStash} onChange={(v) => update({ confirmDiscardStash: v })} label="Discarding or overwriting stashes" />
      <Checkbox checked={settings.confirmForcePush} onChange={(v) => update({ confirmForcePush: v })} label="Force pushing" />
      <Checkbox checked={settings.confirmUndoCommit} onChange={(v) => update({ confirmUndoCommit: v })} label="Undoing a pushed commit" />
      <Checkbox checked={settings.confirmCheckoutCommit} onChange={(v) => update({ confirmCheckoutCommit: v })} label="Checking out a commit (detached HEAD)" />
      <Checkbox checked={settings.confirmCloseIssue} onChange={(v) => update({ confirmCloseIssue: v })} label="Closing an issue" />
      <h4>Switching branches with uncommitted changes</h4>
      <div className="settings-row">
        <label>Default action</label>
        <select value={settings.uncommittedChangesStrategy} onChange={(e) => update({ uncommittedChangesStrategy: e.target.value as AppSettings['uncommittedChangesStrategy'] })}>
          <option value="ask">Ask me where I want the changes to go</option>
          <option value="stash">Always stash and leave my changes on the current branch</option>
          <option value="move">Always bring my changes to the new branch</option>
        </select>
      </div>
      <h4>Notifications</h4>
      <Checkbox checked={settings.notifyPullRequestReviews} onChange={(v) => update({ notifyPullRequestReviews: v })} label="Notify me about pull request reviews" />
      <Checkbox checked={settings.notifyPullRequestChecks} onChange={(v) => update({ notifyPullRequestChecks: v })} label="Notify me when pull request checks fail" />
      <h4>Inbox</h4>
      <Checkbox checked={settings.notificationsEnabled} onChange={(v) => update({ notificationsEnabled: v })} label="Poll GitHub notifications for the Inbox" />
      <div className="settings-row">
        <label>Poll interval</label>
        <input type="number" min={1} max={60} value={settings.notificationsPollIntervalMinutes} onChange={(e) => update({ notificationsPollIntervalMinutes: Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 2)) })} style={{ width: 70 }} disabled={!settings.notificationsEnabled} />
        <span className="hint">minutes (GitHub's own poll-interval header can require longer)</span>
      </div>
      <Checkbox checked={settings.notifyReviewRequests} onChange={(v) => update({ notifyReviewRequests: v })} label="Desktop alert for review requests" disabled={!settings.notificationsEnabled} />
      <Checkbox checked={settings.notifyMentions} onChange={(v) => update({ notifyMentions: v })} label="Desktop alert for mentions" disabled={!settings.notificationsEnabled} />
    </>
  );
}

/** Post-resolution check command field, "Test command" button, repository-command toggle and its trust status, for the AI tab. */
function PostResolveCheckSettings({ ai, updateAi }: { ai: AppSettings['ai']; updateAi: (p: Partial<AppSettings['ai']>) => void }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const [command, setCommand] = useState(ai.postResolveCheck ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [repoConfig, setRepoConfig] = useState<{ command: string | null; trustState: 'trusted' | 'declined' | 'unknown' } | null>(null);

  useEffect(() => {
    setCommand(ai.postResolveCheck ?? '');
  }, [ai.postResolveCheck]);

  useEffect(() => {
    if (!repo) {
      setRepoConfig(null);
      return;
    }
    let cancelled = false;
    void invoke('repo.checkConfig', repo.path).then((c) => {
      if (!cancelled) setRepoConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const commit = (value: string) => updateAi({ postResolveCheck: value.trim() || null });

  return (
    <>
      <div className="settings-row">
        <label>Post-resolution check</label>
        <input
          placeholder="e.g. npm run typecheck"
          value={command}
          spellCheck={false}
          onChange={(e) => setCommand(e.target.value)}
          onBlur={() => commit(command)}
        />
        <Button
          size="sm"
          loading={testing}
          disabled={!command.trim() || !repo}
          onClick={async () => {
            if (!repo) return;
            commit(command);
            setTesting(true);
            setTestResult(null);
            try {
              const result = await invoke('ai.resolve.runCheck', repo.path, command);
              setTestResult({ ok: result.ok, message: result.ok ? `Passed (exit 0, ${result.durationMs}ms).` : result.timedOut ? 'Timed out after 5 minutes.' : `Failed (exit ${result.exitCode ?? '?'}).` });
            } catch (err) {
              setTestResult({ ok: false, message: errorMessage(err) });
            } finally {
              setTesting(false);
            }
          }}
        >
          Test command
        </Button>
      </div>
      {testResult ? <p className="muted" style={{ fontSize: 12, color: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>{testResult.message}</p> : null}
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Runs in the repository root after each successful AI resolution, through your platform's shell, with a 5-minute timeout. A failure blocks auto-staging and offers one AI retry with the check's output.
      </p>
      <Checkbox checked={ai.postResolveCheckFromRepo} onChange={(v) => updateAi({ postResolveCheckFromRepo: v })} label="Allow a repository to provide its own check command (.gitgood/config.json)" />
      {ai.postResolveCheckFromRepo && repoConfig?.command ? (
        <Callout tone={repoConfig.trustState === 'trusted' ? 'success' : repoConfig.trustState === 'declined' ? 'warning' : 'info'}>
          This repository provides a check command: <span className="mono">{repoConfig.command}</span>.{' '}
          {repoConfig.trustState === 'trusted' ? 'Trusted — it runs after each resolution.' : repoConfig.trustState === 'declined' ? (
            <>
              Declined — it will not run.{' '}
              <Button
                variant="link"
                onClick={async () => {
                  if (!repo) return;
                  const result = await invoke('repo.trustConfig', repo.path, true, repoConfig.command);
                  // Refused: the file changed since it was displayed. Show the new command and let the user decide again.
                  setRepoConfig(result.ok ? { ...repoConfig, trustState: 'trusted' } : await invoke('repo.checkConfig', repo.path));
                }}
              >
                Trust it now
              </Button>
            </>
          ) : (
            'You will be asked to confirm the first time it would run.'
          )}
        </Callout>
      ) : null}
    </>
  );
}

const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  resolver: 'Conflict resolution',
  commitMessage: 'Commit messages',
  review: 'Code review',
  split: 'Commit splitting',
  triage: 'Pull request triage',
  prDraft: 'Pull request drafts',
  rebase: 'Rebase plans',
  releaseNotes: 'Release notes',
  explain: 'Diff explanations',
  errorExplain: 'Error explanations',
  nlPalette: 'Command palette',
};

/** This month's and last month's AI usage per feature, from the machine-local usage log. Cost is shown only when the backend reports it. */
function AiUsageSection(): React.JSX.Element {
  const [months, setMonths] = useState<AiUsageMonth[] | null>(null);
  useEffect(() => {
    void invoke('ai.usage.get').then(setMonths).catch(() => setMonths([]));
  }, []);
  const n = (v: number) => v.toLocaleString();
  return (
    <>
      <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Usage</h4>
      {(months ?? []).map((m, i) => {
        const rows = (Object.entries(m.features) as [AiFeature, NonNullable<AiUsageMonth['features'][AiFeature]>][]).sort((a, b) => b[1].requests - a[1].requests);
        return (
          <div key={m.month} style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 12 }}>{i === 0 ? 'This month' : 'Last month'} ({m.month})</strong>
            {rows.length ? (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="muted" style={{ textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', fontWeight: 'normal' }}>Feature</th>
                    <th style={{ fontWeight: 'normal' }}>Requests</th>
                    <th style={{ fontWeight: 'normal' }}>Input</th>
                    <th style={{ fontWeight: 'normal' }}>Output</th>
                    <th style={{ fontWeight: 'normal' }}>Cache reads</th>
                    <th style={{ fontWeight: 'normal' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([feature, t]) => (
                    <tr key={feature} style={{ textAlign: 'right' }}>
                      <td style={{ textAlign: 'left' }}>{AI_FEATURE_LABELS[feature] ?? feature}</td>
                      <td>{n(t.requests)}</td>
                      <td>{n(t.inputTokens)}</td>
                      <td>{n(t.outputTokens)}</td>
                      <td>{n(t.cacheReadTokens)}</td>
                      <td>{t.costUsd === null ? '—' : `$${t.costUsd.toFixed(2)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>No AI requests.</p>
            )}
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Token counts are what the provider reports; cost appears only when the backend reports it (Claude Code does, the API does not). Kept on this machine only; not exported or synced.</p>
    </>
  );
}

function AiTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const errorFeedback = useAppStore((s) => s.aiErrorFeedback);
  const [key, setKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');
  const [savingOpenaiKey, setSavingOpenaiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [customModel, setCustomModel] = useState(!MODELS.some((m) => m.id === settings.ai.model));
  const [agentDraft, setAgentDraft] = useState(settings.ai.agentCustomCommand);
  const ai = settings.ai;
  const updateAi = (patch: Partial<AppSettings['ai']>) => update({ ai: { ...ai, ...patch } });
  const agentQuoting = quotingFor(settings.shell, platform);
  const agentDraftError = ai.agentCommand === 'custom' ? validateAgentTemplate(agentDraft, agentQuoting) : null;
  const saveKey = async () => {
    setSavingKey(true);
    try {
      const next = await invoke('app.setApiKey', key.trim() || null);
      store.set((s) => (s.settings ? { settings: { ...s.settings, ai: next } } : {}));
      setKey('');
    } catch (err) {
      actions.showError('Could not save API key', err);
    } finally {
      setSavingKey(false);
    }
  };
  const saveOpenaiKey = async () => {
    setSavingOpenaiKey(true);
    try {
      const next = await invoke('app.setOpenaiApiKey', openaiKey.trim() || null);
      store.set((s) => (s.settings ? { settings: { ...s.settings, ai: next } } : {}));
      setOpenaiKey('');
    } catch (err) {
      actions.showError('Could not save API key', err);
    } finally {
      setSavingOpenaiKey(false);
    }
  };
  return (
    <>
      <h3>AI conflict resolution</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>One click asks Claude to reconcile both sides of every conflict block in a file. Only the conflicted regions, some surrounding context and the commit subjects on each side are sent. Results are written to the file and can be undone.</p>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Files that look like secrets (.env, private keys, certificates, .netrc, credentials*.json, …) are never sent to any provider, and known token patterns are masked in the text the read-only features send. Individual repositories can opt out from the repository list menu, or with <span className="mono">{'{ "ai": false }'}</span> in <span className="mono">.gitgood/config.json</span>.</p>
      <div className="settings-row">
        <label htmlFor="settings-ai-provider">Provider</label>
        <select id="settings-ai-provider" value={ai.provider} onChange={(e) => updateAi({ provider: e.target.value as AppSettings['ai']['provider'] })}>
          <option value="anthropic">Anthropic API (API key)</option>
          <option value="claude-cli">Claude Code CLI (uses your existing login)</option>
          <option value="openai-compatible">OpenAI-compatible server (OpenAI, Ollama, LM Studio, …)</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>
      {ai.provider === 'anthropic' ? (
        <>
          <div className="settings-row">
            <label>API key</label>
            <input type="password" placeholder={ai.hasApiKey ? '•••••••••••• (stored securely)' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" />
            <Button onClick={() => void saveKey()} loading={savingKey} disabled={!key.trim() && !ai.hasApiKey}>{key.trim() ? 'Save' : ai.hasApiKey ? 'Remove' : 'Save'}</Button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Stored encrypted with the operating system's credential store{isMac ? ' (Keychain)' : window.gitgoodBridge.platform === 'win32' ? ' (DPAPI)' : ''}. If no key is set, the ANTHROPIC_API_KEY environment variable or an <span className="mono">ant auth login</span> profile is used.
          </p>
        </>
      ) : null}
      {ai.provider === 'openai-compatible' ? (
        <>
          <TextField label="Base URL" hint="Include the version path, e.g. https://api.openai.com/v1 or http://localhost:11434/v1. GitGood calls POST {base URL}/chat/completions." value={ai.openaiBaseUrl} placeholder="https://api.openai.com/v1" spellCheck={false} onChange={(e) => updateAi({ openaiBaseUrl: e.target.value.trim() })} />
          <div className="settings-row">
            <label>API key</label>
            <input type="password" placeholder={ai.hasOpenaiApiKey ? '•••••••••••• (stored securely)' : 'Optional for local servers'} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} spellCheck={false} autoComplete="off" />
            <Button onClick={() => void saveOpenaiKey()} loading={savingOpenaiKey} disabled={!openaiKey.trim() && !ai.hasOpenaiApiKey}>{openaiKey.trim() ? 'Save' : ai.hasOpenaiApiKey ? 'Remove' : 'Save'}</Button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Stored encrypted with the operating system's credential store like the Anthropic key, sent only to the base URL above, and never exported or synced. Changing the base URL through a settings import removes the stored key. Requests ask for strict JSON-schema output and fall back to plain JSON mode when the server does not support it.
          </p>
        </>
      ) : null}
      {ai.provider === 'claude-cli' ? (
        <Callout tone={tools?.claudeCli.installed ? 'success' : 'warning'}>
          {tools?.claudeCli.installed ? `Claude Code ${tools.claudeCli.version ?? ''} found at ${tools.claudeCli.path}. Requests use its sign-in and plan.` : 'Claude Code CLI was not found on this machine. Install it (npm install -g @anthropic-ai/claude-code) and sign in, or set its path under Advanced.'}
        </Callout>
      ) : null}
      {ai.provider !== 'disabled' ? (
        <>
          <div className="settings-row">
            <label htmlFor="settings-ai-model">Model</label>
            {ai.provider === 'openai-compatible' ? (
              <input id="settings-ai-model" value={ai.openaiModel} placeholder="e.g. gpt-4o or llama3.1" onChange={(e) => updateAi({ openaiModel: e.target.value.trim() })} spellCheck={false} />
            ) : customModel ? (
              <input id="settings-ai-model" value={ai.model} onChange={(e) => updateAi({ model: e.target.value })} spellCheck={false} />
            ) : (
              <select id="settings-ai-model" value={ai.model} onChange={(e) => updateAi({ model: e.target.value })}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            )}
            <Button size="sm" variant="ghost" onClick={() => setCustomModel((v) => !v)}>{customModel ? 'Presets' : 'Custom'}</Button>
          </div>
          <div className="settings-row">
            <label htmlFor="settings-ai-effort">Effort</label>
            <select id="settings-ai-effort" value={ai.effort} onChange={(e) => updateAi({ effort: e.target.value as AppSettings['ai']['effort'] })}>
              <option value="low">Low (fastest)</option>
              <option value="medium">Medium</option>
              <option value="high">High (default)</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max (most thorough)</option>
            </select>
          </div>
          <details style={{ margin: '8px 0' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12 }}>Model per feature{Object.values(ai.featureModels ?? {}).some(Boolean) ? ' (customised)' : ''}</summary>
            <p className="muted" style={{ fontSize: 12 }}>Leave a field empty to use the model above. A cheaper model for commit messages and triage, a stronger one for review, for example.</p>
            {(Object.keys(AI_FEATURE_LABELS) as AiFeature[]).map((f) => (
              <div className="settings-row" key={f}>
                <label htmlFor={`settings-ai-model-${f}`}>{AI_FEATURE_LABELS[f]}</label>
                <input
                  id={`settings-ai-model-${f}`}
                  value={ai.featureModels?.[f] ?? ''}
                  placeholder={modelFor({ ...ai, featureModels: {} }, f)}
                  spellCheck={false}
                  onChange={(e) => {
                    const { [f]: _removed, ...rest } = ai.featureModels ?? {};
                    updateAi({ featureModels: e.target.value.trim() ? { ...rest, [f]: e.target.value.trim() } : rest });
                  }}
                />
              </div>
            ))}
          </details>
          <Checkbox checked={ai.autoStageAfterResolve} onChange={(v) => updateAi({ autoStageAfterResolve: v })} label="Mark files as resolved automatically after a successful AI resolution" />
          <PostResolveCheckSettings ai={ai} updateAi={updateAi} />
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Pull request review</h4>
          <div className="settings-row">
            <label htmlFor="settings-ai-review-strictness">Strictness</label>
            <select id="settings-ai-review-strictness" value={ai.reviewStrictness} onChange={(e) => updateAi({ reviewStrictness: e.target.value as AppSettings['ai']['reviewStrictness'] })}>
              <option value="strict">Strict — only confident blockers and warnings (default)</option>
              <option value="balanced">Balanced — adds test gaps and readability</option>
              <option value="thorough">Thorough — includes style nits</option>
            </select>
          </div>
          <div className="settings-row">
            <label htmlFor="settings-ai-review-max-files">Review file limit</label>
            <input id="settings-ai-review-max-files" type="number" min={1} max={200} value={ai.reviewMaxFiles} onChange={(e) => updateAi({ reviewMaxFiles: Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 40)) })} style={{ width: 80 }} />
            <span className="hint">Files beyond this limit are listed as skipped in the pre-flight card.</span>
          </div>
          <Checkbox checked={ai.reviewPostFooter} onChange={(v) => updateAi({ reviewPostFooter: v })} label="Append an “AI-assisted” footer to reviews posted to GitHub" />
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Pull request triage</h4>
          <Checkbox checked={ai.triageIncludeDiffStat} onChange={(v) => updateAi({ triageIncludeDiffStat: v })} label="Include per-file change counts in triage requests" />
          <Checkbox checked={ai.triageAutoRefresh} onChange={(v) => updateAi({ triageAutoRefresh: v })} label="Refresh stale triage lines automatically" />
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Triage sends pull request metadata only (titles, bodies, labels, review and check state) — never a diff.</p>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Release notes</h4>
          <div className="settings-row">
            <label htmlFor="settings-ai-release-notes-audience">Audience</label>
            <select id="settings-ai-release-notes-audience" value={ai.releaseNotesAudience} onChange={(e) => updateAi({ releaseNotesAudience: e.target.value as AppSettings['ai']['releaseNotesAudience'] })}>
              <option value="users">Users — skip internal refactors and CI-only changes</option>
              <option value="developers">Developers — include implementation detail</option>
            </select>
          </div>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Pre-commit review</h4>
          <Checkbox checked={ai.reviewBeforeCommit} onChange={(v) => updateAi({ reviewBeforeCommit: v })} label="Review before every commit" />
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Runs the AI review on the exact patch Commit would apply. If it finds anything, a dialog lets you commit anyway or go back; committing is never blocked.</p>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Agent for fixes</h4>
          <div className="settings-row">
            <label htmlFor="settings-ai-agent-command">Fix with agent runs</label>
            <select id="settings-ai-agent-command" value={ai.agentCommand} onChange={(e) => updateAi({ agentCommand: e.target.value as AppSettings['ai']['agentCommand'] })}>
              {AGENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.binary})</option>)}
              <option value="custom">Custom command…</option>
            </select>
          </div>
          {ai.agentCommand === 'custom' ? (
            <TextField
              label="Command"
              value={agentDraft}
              error={agentDraftError ?? undefined}
              hint={agentDraftError ? undefined : '{file} is replaced by the exported findings file, escaped to sit inside double quotes — keep it in a "…" argument.'}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value;
                setAgentDraft(v);
                if (!validateAgentTemplate(v, agentQuoting)) updateAi({ agentCustomCommand: v });
              }}
            />
          ) : null}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            The <b>Fix with agent</b> button on review findings writes them to <span className="mono">gitgood/review/latest.md</span> inside the repository's git directory and opens your terminal (Options → Integrations → Shell) running <span className="mono">{agentTemplate({ agentCommand: ai.agentCommand, agentCustomCommand: agentDraftError ? ai.agentCustomCommand : agentDraft })}</span>. Terminals GitGood cannot start a command in get the command on the clipboard instead. Install the <span className="mono">gitgood-review</span> plugin in your agent for a slash command and a session-start reminder.
          </p>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Command palette</h4>
          <Checkbox checked={ai.nlPaletteEnabled} onChange={(v) => updateAi({ nlPaletteEnabled: v })} label="Show the “Ask AI” row in the command palette (Ctrl+K)" />
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Translates a plain-language request into an exact, previewed plan of git commands. Only repository metadata (branch state, names, recent commits, stashes, remotes, tags) is sent, never file contents; every command is checked against an allowlist before it can run, and destructive steps still open their normal confirmation dialogs.</p>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Error explanation</h4>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>The error dialog's "Explain with AI" row sends the failed command's scrubbed output (tokens and credentials removed) and repository state, and offers fixes drawn only from actions GitGood already exposes.</p>
          <Checkbox checked={ai.explainErrorsAutomatically} onChange={(v) => updateAi({ explainErrorsAutomatically: v })} label="Explain unclassified errors automatically" />
          {errorFeedback.helpful + errorFeedback.notHelpful > 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>This session: {errorFeedback.helpful} found an explanation helpful, {errorFeedback.notHelpful} did not. Never sent anywhere.</p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <Button loading={testing} icon="sparkle" onClick={async () => { setTesting(true); setTestResult(null); try { setTestResult(await invoke('ai.test')); } catch (err) { setTestResult({ ok: false, message: errorMessage(err) }); } finally { setTesting(false); } }}>Test connection</Button>
            {testResult ? <span style={{ color: testResult.ok ? 'var(--success)' : 'var(--danger)', fontSize: 12 }}>{testResult.message}</span> : null}
          </div>
          {ai.provider === 'anthropic' && /claude-(opus-5|fable)/.test(ai.model) ? <p className="muted" style={{ fontSize: 12 }}>Server-side refusal fallback is enabled: if a safety classifier declines a request, the API retries it on a fallback model automatically.</p> : null}
          <AiUsageSection />
        </>
      ) : null}
    </>
  );
}

function AdvancedTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const [info, setInfo] = useState<{ version: string; electron: string; logPath: string; userDataPath: string } | null>(null);
  useEffect(() => {
    void invoke('app.info').then(setInfo);
  }, []);
  const row = (label: string, tool: { installed: boolean; version: string | null; path: string | null; error: string | null; pending?: boolean } | undefined, key: 'gitPath' | 'ghPath' | 'claudeCliPath', install: string) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name={tool?.installed ? 'check-circle' : 'x-circle'} className="" />
        <strong>{label}</strong>
        <span className="muted">{tool?.installed ? tool.version : tool?.error ?? 'checking…'}</span>
      </div>
      <div className="settings-row" style={{ marginTop: 6 }}>
        <label>Path override</label>
        <input placeholder={tool?.path ?? 'auto-detected'} value={(key === 'claudeCliPath' ? settings.ai.claudeCliPath : settings[key]) ?? ''} onChange={(e) => (key === 'claudeCliPath' ? update({ ai: { ...settings.ai, claudeCliPath: e.target.value || null } }) : update({ [key]: e.target.value || null }))} spellCheck={false} />
        <Button size="sm" onClick={() => void invoke('app.chooseFile', { title: `Locate ${label}` }).then((p) => p && (key === 'claudeCliPath' ? update({ ai: { ...settings.ai, claudeCliPath: p } }) : update({ [key]: p })))}>Browse…</Button>
      </div>
      {!tool?.installed && !tool?.pending ? <span className="muted" style={{ fontSize: 12 }}>Install: <span className="mono">{install}</span></span> : null}
    </div>
  );
  return (
    <>
      <h3>Tools</h3>
      {row('Git', tools?.git, 'gitPath', window.gitgoodBridge.platform === 'win32' ? 'winget install Git.Git' : isMac ? 'brew install git' : 'sudo apt install git')}
      {row('GitHub CLI', tools?.gh, 'ghPath', window.gitgoodBridge.platform === 'win32' ? 'winget install GitHub.cli' : isMac ? 'brew install gh' : 'see cli.github.com')}
      {row('Claude Code CLI (optional)', tools?.claudeCli, 'claudeCliPath', 'npm install -g @anthropic-ai/claude-code')}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name={tools?.gitLfs.installed ? 'check-circle' : 'x-circle'} />
          <strong>Git LFS (optional)</strong>
          <span className="muted">{tools?.gitLfs.installed ? tools.gitLfs.version : tools?.gitLfs.error ?? 'checking…'}</span>
        </div>
        {!tools?.gitLfs.installed ? (
          <span className="muted" style={{ fontSize: 12 }}>
            Needed for repositories that use Git LFS. Install: <span className="mono">{window.gitgoodBridge.platform === 'win32' ? 'winget install GitHub.GitLFS' : isMac ? 'brew install git-lfs' : 'sudo apt install git-lfs'}</span>
          </span>
        ) : null}
      </div>
      <Button size="sm" icon="sync" onClick={() => void actions.refreshTools()}>Re-detect tools</Button>
      <h4>Portable settings</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Carry your preferences, repository list and integration choices to another machine, as a file or through a secret GitHub gist. Never includes your API key, saved credentials, custom agent command, tool paths or window position.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button size="sm" icon="upload" onClick={() => openDialog({ kind: 'export-settings' })}>Export…</Button>
        <Button size="sm" icon="download" onClick={() => openDialog({ kind: 'import-settings' })}>Import…</Button>
      </div>
      <h5 style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Sync with GitHub gist</h5>
      <SettingsSyncCard />
      <h4>Updates</h4>
      <Checkbox checked={settings.checkForUpdatesAutomatically} onChange={(v) => update({ checkForUpdatesAutomatically: v })} label="Automatically check for updates" />
      <Checkbox checked={settings.autoDownloadUpdates} onChange={(v) => update({ autoDownloadUpdates: v })} label="Automatically download updates once found" disabled={!settings.checkForUpdatesAutomatically} />
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>This build can only detect and link to new releases; it cannot download or install them yet. Automatic download will take effect once that ships.</p>
      <div className="settings-row">
        <label htmlFor="settings-update-channel">Channel</label>
        <select id="settings-update-channel" value={settings.updateChannel} onChange={(e) => update({ updateChannel: e.target.value as AppSettings['updateChannel'] })}>
          <option value="stable">Stable</option>
          <option value="beta">Beta (includes prereleases)</option>
        </select>
      </div>
      <Button size="sm" icon="sync" onClick={() => void actions.checkForUpdates()}>Check for updates now</Button>
      <h4>Inbox cache</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>The notifications inbox caches its list on disk so it can show something while offline. Because that list can include the titles of private repositories, you can clear it here at any time; the panel reloads from GitHub on its next poll.</p>
      <Button size="sm" icon="trash" onClick={() => void actions.clearInboxCache()}>Clear inbox cache</Button>
      <h4>Diagnostics</h4>
      {info ? (
        <p className="muted" style={{ fontSize: 12 }}>
          GitGood {info.version} · Electron {info.electron}
          <br />
          <Button variant="link" onClick={() => void invoke('app.showItemInFolder', info.logPath)}>Show log file</Button> · <Button variant="link" onClick={() => void invoke('app.openPath', info.userDataPath)}>Open data folder</Button>
        </p>
      ) : null}
      <p className="muted" style={{ fontSize: 12 }}>Keyboard shortcuts: {formatAccelerator(mergeShortcuts(settings.shortcuts)['keyboard-shortcuts'] ?? '', isMac) || 'unassigned'}</p>
    </>
  );
}

function UpdateStatusLine(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings);
  const updateState = useAppStore((s) => s.updateState);
  const [checking, setChecking] = useState(false);
  if (!settings) return null;
  const checkNow = async () => {
    setChecking(true);
    try {
      await actions.checkForUpdates();
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 12 }}>Channel: {settings.updateChannel === 'beta' ? 'Beta (includes prereleases)' : 'Stable'}</p>
      {updateState.status === 'disabled' ? (
        <Callout tone="warning">{updateState.reason}</Callout>
      ) : updateState.status === 'available' ? (
        <Callout tone="success">
          GitGood {updateState.version} is available. <Button size="sm" variant="link" onClick={() => void actions.downloadUpdate()}>Download</Button>
        </Callout>
      ) : updateState.status === 'downloading' ? (
        <Callout tone="info">
          Downloading GitGood {updateState.version}{updateState.percent != null ? ` (${Math.round(updateState.percent)}%)` : ''}…
        </Callout>
      ) : updateState.status === 'ready' ? (
        <Callout tone="success">
          GitGood {updateState.version} is ready to install. <Button size="sm" variant="link" onClick={() => void actions.installUpdate()}>Restart to update</Button>
        </Callout>
      ) : updateState.status === 'error' ? (
        <Callout tone="danger">{updateState.message}</Callout>
      ) : null}
      {updateState.status !== 'disabled' ? (
        <Button size="sm" icon="sync" loading={checking || updateState.status === 'checking'} onClick={() => void checkNow()}>Check now</Button>
      ) : null}
    </>
  );
}

export function AboutDialog(): React.JSX.Element {
  const [info, setInfo] = useState<{ version: string; electron: string; platform: string } | null>(null);
  useEffect(() => {
    void invoke('app.info').then((i) => setInfo({ version: i.version, electron: i.electron, platform: String(i.platform) }));
  }, []);
  return (
    <Dialog title="About GitGood" icon="repo" onClose={closeDialog} footer={<Button variant="primary" onClick={closeDialog}>Close</Button>}>
      <p>
        <strong>GitGood</strong> {info?.version ?? ''}
      </p>
      <p className="muted">A GitHub Desktop-style Git client that drives the <span className="mono">git</span> and <span className="mono">gh</span> command-line tools, so a single GitHub CLI sign-in handles fetching, pulling, pushing and pull requests. Includes one-click AI merge conflict resolution powered by Claude.</p>
      {info ? <p className="muted" style={{ fontSize: 12 }}>Electron {info.electron} · {info.platform}</p> : null}
      <UpdateStatusLine />
      <p>
        <Button variant="link" onClick={() => void actions.openExternal('https://github.com/erwin-wee/gitgood')}>github.com/erwin-wee/gitgood</Button>
      </p>
    </Dialog>
  );
}

export function UpdateNotesDialog({ version, notes, url }: { version: string; notes: string; url: string }): React.JSX.Element {
  return (
    <Dialog title={`GitGood ${version}`} icon="download" onClose={closeDialog} footer={<Button variant="primary" onClick={closeDialog}>Close</Button>}>
      <LinkifiedText text={notes} />
      <p style={{ marginTop: 12 }}>
        <Button variant="link" onClick={() => void actions.openExternal(url)}>View this release on GitHub</Button>
      </p>
    </Dialog>
  );
}

export function ShortcutsDialog(): React.JSX.Element {
  const overrides = useAppStore((s) => s.settings?.shortcuts) ?? {};
  const shortcuts = mergeShortcuts(overrides);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; accelerator: string; conflict: ShortcutConflict } | null>(null);
  const labelOf = (id: string): string => SHORTCUTS.find((d) => d.id === id)?.label ?? id;
  const save = (next: ShortcutOverrides): void => void actions.updateSettings({ shortcuts: next });

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent): void => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        setNote(null);
        return;
      }
      const accelerator = acceleratorFromEvent(e, isMac);
      if (!accelerator) {
        setNote('That key cannot be bound on its own: combine it with Ctrl/Cmd or Alt, or use a function key.');
        return;
      }
      const conflict = findConflict(shortcuts, recording, accelerator, isMac);
      if (conflict?.id === null) {
        setNote(`${formatAccelerator(accelerator, isMac)} is reserved for "${conflict.label}". Press another combination.`);
        return;
      }
      setRecording(null);
      setNote(null);
      if (conflict) setPending({ id: recording, accelerator, conflict });
      else save(setShortcut(overrides, recording, accelerator));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = SHORTCUTS.filter(({ id, category, label }) => {
    const haystack = `${category} ${label} ${shortcuts[id] ? formatAccelerator(shortcuts[id], isMac) : ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const customised = Object.keys(overrides).length > 0;
  return (
    <Dialog
      title="Keyboard shortcuts"
      icon="info"
      onClose={closeDialog}
      footer={
        <>
          <Button disabled={!customised} onClick={() => save({})}>Reset all to defaults</Button>
          <Button variant="primary" onClick={closeDialog}>Close</Button>
        </>
      }
    >
      <FilterInput value={query} onChange={setQuery} placeholder="Filter shortcuts" label="Filter keyboard shortcuts" autoFocus />
      {pending ? (
        <Callout tone="warning">
          <p style={{ margin: '0 0 6px' }}>
            <kbd>{formatAccelerator(pending.accelerator, isMac)}</kbd> is already used by "{pending.conflict.label}". Use it for "{labelOf(pending.id)}" and unbind "{pending.conflict.label}"?
          </p>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              save(setShortcut(setShortcut(overrides, pending.conflict.id!, null), pending.id, pending.accelerator));
              setPending(null);
            }}
          >
            Unbind "{pending.conflict.label}" and use it here
          </Button>{' '}
          <Button size="sm" onClick={() => setPending(null)}>Cancel</Button>
        </Callout>
      ) : null}
      {note ? <Callout tone="warning">{note}</Callout> : null}
      {SHORTCUT_CATEGORIES.map((category) => {
        const categoryRows = rows.filter((row) => row.category === category);
        if (categoryRows.length === 0) return null;
        const headingId = `shortcut-category-${category.toLowerCase().replace(/ /g, '-')}`;
        return (
          <section key={category} aria-labelledby={headingId}>
            <h3 id={headingId} style={{ margin: '14px 0 4px', fontSize: 12 }}>{category}</h3>
            <table className="shortcut-table">
              <tbody>
                {categoryRows.map(({ id, label }) => (
                  <tr key={id}>
                    <td>{label}</td>
                    <td>
                      {recording === id ? <em>Press the new keys… (Esc cancels)</em> : shortcuts[id] ? <kbd>{formatAccelerator(shortcuts[id], isMac)}</kbd> : <span className="muted">Unassigned</span>}{' '}
                      <Button size="sm" variant="ghost" aria-label={`Change shortcut for ${label}`} onClick={() => { setPending(null); setNote(null); setRecording(recording === id ? null : id); }}>{recording === id ? 'Cancel' : 'Change'}</Button>
                      {shortcuts[id] ? <Button size="sm" variant="ghost" aria-label={`Unbind shortcut for ${label}`} onClick={() => save(setShortcut(overrides, id, null))}>Unbind</Button> : null}
                      {Object.hasOwn(overrides, id) ? <Button size="sm" variant="ghost" aria-label={`Reset shortcut for ${label}`} onClick={() => save(setShortcut(overrides, id, SHORTCUTS.find((d) => d.id === id)!.accelerator))}>Reset</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      {rows.length === 0 ? <p className="muted" style={{ marginTop: 12 }}>No matching shortcuts.</p> : null}
    </Dialog>
  );
}
