import React, { useEffect, useState } from 'react';
import type { ImportPreview, SettingsSection, SettingsSyncStatus } from '@shared/types';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, showToast, useAppStore } from '../../state/store';
import { Button, Callout, Checkbox, Dialog, RelativeTime, Spinner } from '../ui';

const SECTION_LABELS: Record<SettingsSection, string> = {
  preferences: 'Preferences (theme, diff, confirmations, notifications, …)',
  repositories: 'Repository list (paths and aliases)',
  integrations: 'Integrations (external editor and shell)',
};

export function ExportSettingsDialog(): React.JSX.Element {
  const [sections, setSections] = useState<Set<SettingsSection>>(new Set<SettingsSection>(['preferences', 'repositories', 'integrations']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (s: SettingsSection) =>
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await invoke('app.chooseSavePath', { title: 'Export settings', defaultPath: 'gitgood-settings.json', filters: [{ name: 'GitGood settings', extensions: ['json'] }] });
      if (!path) return;
      await invoke('settings.exportToFile', path, [...sections]);
      closeDialog();
      showToast({ kind: 'success', title: 'Settings exported', action: { label: 'Show in folder', onClick: () => void invoke('app.showItemInFolder', path) } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Export settings"
      icon="upload"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!sections.size} onClick={() => void doExport()}>
            Export…
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>Choose what to include in the exported file.</p>
      {(Object.keys(SECTION_LABELS) as SettingsSection[]).map((s) => (
        <Checkbox key={s} checked={sections.has(s)} onChange={() => toggle(s)} label={SECTION_LABELS[s]} />
      ))}
      <Callout tone="info" icon="lock">
        This file never includes your API key, saved GitHub credentials, tool paths, or window position — only the settings above.
      </Callout>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}

export function ImportSettingsDialog(): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sections, setSections] = useState<Set<SettingsSection>>(new Set());
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = async (p: string, m: 'merge' | 'replace', selectSections: boolean) => {
    setPreview(null);
    setError(null);
    setLoading(true);
    try {
      const pv = await invoke('settings.previewImport', p, m);
      setPreview(pv);
      if (selectSections) setSections(new Set(pv.sections.map((s) => s.name)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const choose = async () => {
    const p = await invoke('app.chooseFile', { title: 'Import settings', filters: [{ name: 'GitGood settings', extensions: ['json'] }] });
    if (!p) return;
    setPath(p);
    await loadPreview(p, mode, true);
  };

  /** `replace` resets omitted fields to their defaults, so its counts differ from `merge`'s -- re-preview on every mode change. */
  const changeMode = (m: 'merge' | 'replace') => {
    setMode(m);
    if (path && m !== mode) void loadPreview(path, m, false);
  };

  const toggle = (s: SettingsSection) =>
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const doImport = async () => {
    if (!path) return;
    setImporting(true);
    setError(null);
    try {
      await invoke('settings.import', path, mode, [...sections]);
      closeDialog();
      showToast({ kind: 'success', title: 'Settings imported' });
    } catch (err) {
      // In `replace` mode this runs from the confirmation dialog's onConfirm,
      // by which point this dialog is no longer mounted and setError would be
      // dropped -- so the failure is reported by toast too, never silently.
      setError(errorMessage(err));
      showToast({ kind: 'error', title: 'Could not import settings', message: errorMessage(err) }, 12000);
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = () => {
    if (mode === 'replace') {
      openDialog({
        kind: 'confirm',
        title: 'Replace settings?',
        message: 'Fields in the selected sections that are not present in the file are reset to their defaults. A backup of your current settings is saved first.',
        confirmLabel: 'Replace',
        danger: true,
        onConfirm: doImport,
      });
    } else {
      void doImport();
    }
  };

  return (
    <Dialog
      title="Import settings"
      icon="download"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant={mode === 'replace' ? 'danger' : 'primary'} loading={importing} disabled={!preview || !sections.size} onClick={confirmImport}>
            Import
          </Button>
        </>
      }
    >
      <div className="settings-row">
        <label>File</label>
        <input readOnly value={path ?? ''} placeholder="No file chosen" />
        <Button onClick={() => void choose()}>Choose…</Button>
      </div>
      {loading ? <Spinner /> : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {preview ? (
        <>
          {!preview.sections.length ? (
            <Callout tone="warning">This file has no importable sections.</Callout>
          ) : (
            <table className="import-preview-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Section</th>
                  <th>New</th>
                  <th>Changed</th>
                  <th>Unchanged</th>
                </tr>
              </thead>
              <tbody>
                {preview.sections.map((s) => (
                  <tr key={s.name}>
                    <td>
                      <Checkbox checked={sections.has(s.name)} onChange={() => toggle(s.name)} />
                    </td>
                    <td>{SECTION_LABELS[s.name]}</td>
                    <td>{s.adds}</td>
                    <td>{s.changes}</td>
                    <td>{s.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="settings-row" style={{ marginTop: 12 }}>
            <label>Mode</label>
            <select value={mode} onChange={(e) => changeMode(e.target.value as 'merge' | 'replace')}>
              <option value="merge">Merge — keep everything not in the file</option>
              <option value="replace">Replace — reset omitted fields to defaults</option>
            </select>
          </div>
          {preview.missingRepositories.length ? (
            <Callout tone="info">
              {preview.missingRepositories.length} imported {preview.missingRepositories.length === 1 ? 'repository' : 'repositories'} could not be found on this machine and will appear in the repository list marked Missing — right-click one there to relocate it.
            </Callout>
          ) : null}
          {preview.warnings.length ? (
            <div className="file-preview-list" style={{ marginTop: 8 }}>
              {preview.warnings.map((w, i) => (
                <div key={i} className="muted" style={{ fontSize: 12 }}>{w}</div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}

/**
 * Options → Advanced "Sync with GitHub gist" card: signed-out/no-gh degraded
 * states, disabled/enabled states, and the actions for each (see spec's
 * "Degraded states" and "Gist sync" requirements).
 *
 * Enable/Download/Disconnect run behind a confirm dialog. Opening a dialog
 * replaces the current one (see openDialog in state/store.ts), so this card
 * unmounts for the duration of the confirmation and a fresh instance mounts
 * when it closes — a local "refresh when done" callback would update a
 * component that is no longer on screen. `settingsSyncVersion` (bumped after
 * each action, regardless of which instance is mounted) is used instead, so
 * whichever instance is current always re-fetches status.
 */
export function SettingsSyncCard(): React.JSX.Element {
  const tools = useAppStore((s) => s.tools);
  const syncVersion = useAppStore((s) => s.settingsSyncVersion);
  const [status, setStatus] = useState<SettingsSyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await invoke('settings.sync.status'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tools?.ghAccount) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools?.ghAccount?.login, syncVersion]);

  if (!tools) return <Spinner />;
  if (!tools.gh.installed) return <Callout tone="warning">Install the GitHub CLI to sync settings (see Tools above).</Callout>;
  if (!tools.ghAccount) {
    return (
      <Callout tone="info">
        Sign in to GitHub to sync settings through a secret gist. <Button size="sm" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in</Button>
      </Callout>
    );
  }

  const enable = () =>
    openDialog({
      kind: 'confirm',
      title: 'Enable settings sync',
      message: 'GitGood stores an export of your settings in a secret GitHub gist. Secret gists are not listed publicly, but anyone with the link can read them. Only the fields you can also export to a file are included — never your API key or saved credentials.',
      confirmLabel: 'Enable',
      onConfirm: async () => {
        try {
          await invoke('settings.sync.enable');
        } catch (err) {
          actions.showError('Could not enable sync', err);
        } finally {
          actions.bumpSettingsSyncVersion();
        }
      },
    });

  const upload = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke('settings.sync.upload');
      await refresh();
      showToast({ kind: 'success', title: 'Uploaded to gist' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    let replace = false;
    openDialog({
      kind: 'confirm',
      title: 'Download settings',
      message: 'Merge keeps everything not present in the gist. Replace resets your local settings to match the gist exactly; a backup is saved first.',
      confirmLabel: 'Download',
      checkbox: { label: 'Replace instead of merge', onChange: (v) => (replace = v) },
      onConfirm: async () => {
        try {
          await invoke('settings.sync.download', replace ? 'replace' : 'merge');
          showToast({ kind: 'success', title: 'Downloaded from gist' });
        } catch (err) {
          actions.showError('Could not download settings', err);
        } finally {
          actions.bumpSettingsSyncVersion();
        }
      },
    });
  };

  const disconnect = () => {
    let deleteGist = false;
    openDialog({
      kind: 'confirm',
      title: 'Disconnect sync',
      message: 'This stops syncing on this machine. The gist stays on GitHub unless you choose to delete it.',
      confirmLabel: 'Disconnect',
      danger: true,
      checkbox: { label: 'Also delete the gist on GitHub', onChange: (v) => (deleteGist = v) },
      onConfirm: async () => {
        try {
          await invoke('settings.sync.disable', deleteGist);
        } catch (err) {
          actions.showError('Could not disconnect', err);
        } finally {
          actions.bumpSettingsSyncVersion();
        }
      },
    });
  };

  if (!status) return loading ? <Spinner /> : error ? <Callout tone="danger">{error}</Callout> : <Spinner />;

  if (!status.enabled) {
    return (
      <>
        <p className="muted" style={{ marginTop: 0 }}>Sync your settings between machines through a secret GitHub gist. No background sync — you choose when to upload or download.</p>
        <Button variant="primary" icon="sync" onClick={enable}>Enable sync</Button>
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </>
    );
  }

  const stateCallout = (): React.JSX.Element | null => {
    switch (status.state) {
      case 'gist-missing':
        return <Callout tone="danger">The settings gist no longer exists.</Callout>;
      case 'up-to-date':
        return <Callout tone="success">Up to date.</Callout>;
      case 'local-newer':
        return <Callout tone="warning">Your local settings changed since the last sync. Upload to update the gist.</Callout>;
      case 'remote-newer':
        return <Callout tone="warning">The gist has changes this machine doesn't have. Download to apply them.</Callout>;
      case 'diverged':
        return <Callout tone="danger">Both sides changed since the last sync. Choose which to keep — nothing merges automatically.</Callout>;
      default:
        return null;
    }
  };

  return (
    <>
      {stateCallout()}
      <p className="muted" style={{ fontSize: 12 }}>
        Gist: <span className="mono">{status.gistId}</span>
        {status.lastSyncedAt ? (
          <>
            {' '}
            · Last synced <RelativeTime date={status.lastSyncedAt} />
          </>
        ) : null}
        {status.remoteUpdatedAt ? (
          <>
            {' '}
            · Gist updated <RelativeTime date={status.remoteUpdatedAt} />
          </>
        ) : null}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" icon="sync" loading={loading} onClick={() => void refresh()}>Sync now</Button>
        {status.state === 'gist-missing' ? (
          <Button size="sm" variant="primary" onClick={enable}>Create new gist</Button>
        ) : (
          <>
            <Button size="sm" icon="upload" loading={busy} onClick={() => void upload()}>Upload</Button>
            <Button size="sm" icon="download" onClick={download}>Download…</Button>
          </>
        )}
        <Button size="sm" variant="danger" onClick={disconnect}>Disconnect</Button>
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </>
  );
}
