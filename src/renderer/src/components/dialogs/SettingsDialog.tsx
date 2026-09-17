import React, { useEffect, useState } from 'react';
import type { AppSettings, FoundEditor, FoundShell } from '@shared/types';
import { errorMessage, invoke, isMac, modKey } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, store, useAppStore, type SettingsTab } from '../../state/store';
import { Avatar, Button, Callout, Checkbox, Dialog, Icon, Spinner, TextField, type IconName } from '../ui';

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
      <h4>Lists</h4>
      <Checkbox checked={settings.repositoryIndicators} onChange={(v) => update({ repositoryIndicators: v })} label="Show ahead/behind and change indicators in the repository list" />
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
    </>
  );
}

function AiTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
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
      <Button size="sm" icon="sync" onClick={() => void actions.refreshTools()}>Re-detect tools</Button>
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
      <p>
        <Button variant="link" onClick={() => void actions.openExternal('https://github.com/erwin-wee/gitgood')}>github.com/erwin-wee/gitgood</Button>
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
    ['Show Changes', `${m}+1`],
    ['Show History', `${m}+2`],
    ['Repository list', `${m}+T`],
    ['Branch list', `${m}+B`],
    ['Go to commit summary', `${m}+G`],
    ['Commit', `${m}+Enter`],
    ['Toggle split diff', `${m}+Shift+D`],
    ['Push', `${m}+P`],
    ['Pull', `${m}+Shift+P`],
    ['Fetch', `${m}+Shift+T`],
    ['New branch', `${m}+Shift+N`],
    ['Merge into current branch', `${m}+Shift+M`],
    ['Rebase current branch', `${m}+Shift+E`],
    ['Update from default branch', `${m}+Shift+U`],
    ['Create pull request', `${m}+R`],
    ['View on GitHub', `${m}+Shift+G`],
    ['Open in terminal', 'Ctrl+`'],
    ['Show in folder', `${m}+Shift+F`],
    ['Open in external editor', `${m}+Shift+A`],
    ['Stash all changes', `${m}+Shift+S`],
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
