import React, { useEffect, useState } from 'react';
import type { AppSettings, FoundEditor, FoundShell, SigningConfig, SigningConfigInfo, SigningKey } from '@shared/types';
import { errorMessage, invoke, isMac, modKey } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, store, useAppStore, type SettingsTab } from '../../state/store';
import { Avatar, Button, Callout, Checkbox, Dialog, Icon, Spinner, TextField, type IconName } from '../ui';
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
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h3>GitHub.com</h3>
      {account ? (
        <>
          <div className="account-card">
            <Avatar email={`${account.login}@users.noreply.github.com`} name={account.name ?? account.login} size={40} />
            <span className="who">
              <strong>{account.name ?? account.login}</strong>
              <span className="muted">@{account.login} · {account.host}</span>
            </span>
            <Button loading={busy} onClick={async () => { setBusy(true); await actions.signOut(account.host); setBusy(false); }}>Sign out</Button>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Token scopes: {account.scopes.join(', ') || 'unknown'} · Git protocol: {account.protocol ?? 'https'}</p>
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
          <Button variant="primary" icon="github" onClick={() => openDialog({ kind: 'sign-in' })} disabled={tools ? !tools.gh.installed : false}>Sign in to GitHub.com</Button>
          {tools && !tools.gh.installed ? <Callout tone="warning">Install the GitHub CLI first (see the Advanced tab).</Callout> : null}
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
      <h4>Pull behavior</h4>
      <div className="settings-row">
        <label>When pulling</label>
        <select value={settings.pullBehavior} onChange={(e) => update({ pullBehavior: e.target.value as AppSettings['pullBehavior'] })}>
          <option value="git-config">Follow Git config (pull.rebase)</option>
          <option value="merge">Merge remote changes</option>
          <option value="rebase">Rebase local commits on top</option>
        </select>
      </div>
      <h4>Background fetch</h4>
      <div className="settings-row">
        <label>Fetch every</label>
        <select value={settings.autoFetchIntervalMinutes} onChange={(e) => update({ autoFetchIntervalMinutes: Number(e.target.value) })}>
          <option value={0}>Never</option>
          <option value={5}>5 minutes</option>
          <option value={10}>10 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
        </select>
      </div>
      <h4>Repository health</h4>
      <div className="settings-row">
        <label>A branch is inactive after</label>
        <input type="number" min={1} max={3650} value={settings.staleBranchDays} onChange={(e) => update({ staleBranchDays: Math.max(1, Number(e.target.value) || 90) })} style={{ flex: '0 0 80px' }} /> days without a commit
      </div>
      <div className="settings-row">
        <label>Warn about blobs at or above</label>
        <input
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
        <label>Default view</label>
        <select value={settings.diffViewMode} onChange={(e) => update({ diffViewMode: e.target.value as 'unified' | 'split' })}>
          <option value="unified">Unified</option>
          <option value="split">Split (side by side)</option>
        </select>
      </div>
      <div className="settings-row">
        <label>Font size</label>
        <input type="number" min={9} max={24} value={settings.diffFontSize} onChange={(e) => update({ diffFontSize: Math.max(9, Math.min(24, Number(e.target.value) || 12)) })} style={{ flex: '0 0 80px' }} />
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
                  await invoke('repo.trustConfig', repo.path, true);
                  setRepoConfig({ ...repoConfig, trustState: 'trusted' });
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

function AiTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const errorFeedback = useAppStore((s) => s.aiErrorFeedback);
  const [key, setKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [customModel, setCustomModel] = useState(!MODELS.some((m) => m.id === settings.ai.model));
  const ai = settings.ai;
  const updateAi = (patch: Partial<AppSettings['ai']>) => update({ ai: { ...ai, ...patch } });
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
  return (
    <>
      <h3>AI conflict resolution</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>One click asks Claude to reconcile both sides of every conflict block in a file. Only the conflicted regions, some surrounding context and the commit subjects on each side are sent. Results are written to the file and can be undone.</p>
      <div className="settings-row">
        <label>Provider</label>
        <select value={ai.provider} onChange={(e) => updateAi({ provider: e.target.value as AppSettings['ai']['provider'] })}>
          <option value="anthropic">Anthropic API (API key)</option>
          <option value="claude-cli">Claude Code CLI (uses your existing login)</option>
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
      {ai.provider === 'claude-cli' ? (
        <Callout tone={tools?.claudeCli.installed ? 'success' : 'warning'}>
          {tools?.claudeCli.installed ? `Claude Code ${tools.claudeCli.version ?? ''} found at ${tools.claudeCli.path}. Requests use its sign-in and plan.` : 'Claude Code CLI was not found on this machine. Install it (npm install -g @anthropic-ai/claude-code) and sign in, or set its path under Advanced.'}
        </Callout>
      ) : null}
      {ai.provider !== 'disabled' ? (
        <>
          <div className="settings-row">
            <label>Model</label>
            {customModel ? (
              <input value={ai.model} onChange={(e) => updateAi({ model: e.target.value })} spellCheck={false} />
            ) : (
              <select value={ai.model} onChange={(e) => updateAi({ model: e.target.value })}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            )}
            <Button size="sm" variant="ghost" onClick={() => setCustomModel((v) => !v)}>{customModel ? 'Presets' : 'Custom'}</Button>
          </div>
          <div className="settings-row">
            <label>Effort</label>
            <select value={ai.effort} onChange={(e) => updateAi({ effort: e.target.value as AppSettings['ai']['effort'] })}>
              <option value="low">Low (fastest)</option>
              <option value="medium">Medium</option>
              <option value="high">High (default)</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max (most thorough)</option>
            </select>
          </div>
          <Checkbox checked={ai.autoStageAfterResolve} onChange={(v) => updateAi({ autoStageAfterResolve: v })} label="Mark files as resolved automatically after a successful AI resolution" />
          <PostResolveCheckSettings ai={ai} updateAi={updateAi} />
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Pull request review</h4>
          <div className="settings-row">
            <label>Strictness</label>
            <select value={ai.reviewStrictness} onChange={(e) => updateAi({ reviewStrictness: e.target.value as AppSettings['ai']['reviewStrictness'] })}>
              <option value="strict">Strict — only confident blockers and warnings (default)</option>
              <option value="balanced">Balanced — adds test gaps and readability</option>
              <option value="thorough">Thorough — includes style nits</option>
            </select>
          </div>
          <div className="settings-row">
            <label>Review file limit</label>
            <input type="number" min={1} max={200} value={ai.reviewMaxFiles} onChange={(e) => updateAi({ reviewMaxFiles: Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 40)) })} style={{ width: 80 }} />
            <span className="hint">Files beyond this limit are listed as skipped in the pre-flight card.</span>
          </div>
          <Checkbox checked={ai.reviewPostFooter} onChange={(v) => updateAi({ reviewPostFooter: v })} label="Append an “AI-assisted” footer to reviews posted to GitHub" />
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Pull request triage</h4>
          <Checkbox checked={ai.triageIncludeDiffStat} onChange={(v) => updateAi({ triageIncludeDiffStat: v })} label="Include per-file change counts in triage requests" />
          <Checkbox checked={ai.triageAutoRefresh} onChange={(v) => updateAi({ triageAutoRefresh: v })} label="Refresh stale triage lines automatically" />
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Triage sends pull request metadata only (titles, bodies, labels, review and check state) — never a diff.</p>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Release notes</h4>
          <div className="settings-row">
            <label>Audience</label>
            <select value={ai.releaseNotesAudience} onChange={(e) => updateAi({ releaseNotesAudience: e.target.value as AppSettings['ai']['releaseNotesAudience'] })}>
              <option value="users">Users — skip internal refactors and CI-only changes</option>
              <option value="developers">Developers — include implementation detail</option>
            </select>
          </div>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Pre-commit review</h4>
          <Checkbox checked={ai.reviewBeforeCommit} onChange={(v) => updateAi({ reviewBeforeCommit: v })} label="Review before every commit" />
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Runs the AI review on the exact patch Commit would apply. If it finds anything, a dialog lets you commit anyway or go back; committing is never blocked.</p>
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
  const row = (label: string, tool: { installed: boolean; version: string | null; path: string | null; error: string | null } | undefined, key: 'gitPath' | 'ghPath' | 'claudeCliPath', install: string) => (
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
      {!tool?.installed ? <span className="muted" style={{ fontSize: 12 }}>Install: <span className="mono">{install}</span></span> : null}
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
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Carry your preferences, repository list and integration choices to another machine, as a file or through a secret GitHub gist. Never includes your API key, saved credentials, tool paths or window position.</p>
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
        <label>Channel</label>
        <select value={settings.updateChannel} onChange={(e) => update({ updateChannel: e.target.value as AppSettings['updateChannel'] })}>
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
      <p className="muted" style={{ fontSize: 12 }}>Keyboard shortcuts: {modKey}+/ </p>
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
  const m = modKey;
  const rows: [string, string][] = [
    ['New repository', `${m}+N`],
    ['Add local repository', `${m}+O`],
    ['Clone repository', `${m}+Shift+O`],
    ['Options', `${m}+,`],
    ['Ask GitGood (command palette)', `${m}+K`],
    ['Show Changes', `${m}+1`],
    ['Show History', `${m}+2`],
    ['Show Stashes', `${m}+Shift+S`],
    ['Repository health', `${m}+Shift+K`],
    ['Repository list', `${m}+T`],
    ['Branch list', `${m}+B`],
    ['Notifications inbox', `${m}+Shift+J`],
    ['Go to commit summary', `${m}+G`],
    ['Commit', `${m}+Enter`],
    ['Toggle split diff', `${m}+Shift+D`],
    ['Toggle blame', 'Alt+B'],
    ['Push', `${m}+P`],
    ['Pull', `${m}+Shift+P`],
    ['Fetch', `${m}+Shift+T`],
    ['New branch', `${m}+Shift+N`],
    ['Merge into current branch', `${m}+Shift+M`],
    ['Rebase current branch', `${m}+Shift+E`],
    ['Update from default branch', `${m}+Shift+U`],
    ['Create pull request', `${m}+R`],
    ['Review pull request with AI', `${m}+Shift+R`],
    ['View on GitHub', `${m}+Shift+G`],
    ['Open in terminal', 'Ctrl+`'],
    ['Show in folder', `${m}+Shift+F`],
    ['Open in external editor', `${m}+Shift+A`],
    ['Discard all changes', `${m}+Shift+Backspace`],
    ['Zoom in / out / reset', `${m}+= / ${m}+- / ${m}+0`],
  ];
  return (
    <Dialog title="Keyboard shortcuts" icon="info" onClose={closeDialog} footer={<Button variant="primary" onClick={closeDialog}>Close</Button>}>
      <table className="shortcut-table">
        <tbody>
          {rows.map(([label, keys]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>
                {keys.split(' / ').map((k, i) => (
                  <span key={i}>
                    {i > 0 ? ' / ' : ''}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
