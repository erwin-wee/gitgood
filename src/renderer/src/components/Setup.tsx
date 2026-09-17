import React from 'react';
import type { ToolsState } from '@shared/types';
import { isMac, isWindows } from '../api';
import * as actions from '../state/actions';
import { openDialog } from '../state/store';
import { Button, Icon } from './ui';

export function SetupScreen({ tools }: { tools: ToolsState }): React.JSX.Element {
  const gitInstall = isWindows ? 'winget install --id Git.Git -e' : isMac ? 'xcode-select --install   (or: brew install git)' : 'sudo apt install git   (or your distro equivalent)';
  const ghInstall = isWindows ? 'winget install --id GitHub.cli -e' : isMac ? 'brew install gh' : 'See https://cli.github.com for your distribution';
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1>
          <Icon name="alert" /> GitGood needs Git to run
        </h1>
        <p className="muted">GitGood drives the git and gh command-line tools rather than bundling its own Git. Install the missing tools, then click “Check again”.</p>
        <div className="setup-item">
          <Icon name={tools.git.installed ? 'check-circle' : 'x-circle'} />
          <div>
            <strong>Git {tools.git.installed ? `${tools.git.version} found` : 'not found'}</strong>
            {!tools.git.installed ? (
              <span>
                Install with <span className="mono">{gitInstall}</span> or download from <Button variant="link" onClick={() => void actions.openExternal('https://git-scm.com/downloads')}>git-scm.com</Button>.{tools.git.error ? ` (${tools.git.error})` : ''}
              </span>
            ) : (
              <span className="mono">{tools.git.path}</span>
            )}
          </div>
        </div>
        <div className="setup-item">
          <Icon name={tools.gh.installed ? 'check-circle' : 'x-circle'} />
          <div>
            <strong>GitHub CLI {tools.gh.installed ? `${tools.gh.version} found` : 'not found (needed for GitHub features)'}</strong>
            {!tools.gh.installed ? (
              <span>
                Install with <span className="mono">{ghInstall}</span> or download from <Button variant="link" onClick={() => void actions.openExternal('https://cli.github.com')}>cli.github.com</Button>.
              </span>
            ) : (
              <span className="mono">{tools.gh.path}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button variant="primary" icon="sync" onClick={() => void actions.refreshTools()}>Check again</Button>
          <Button onClick={() => openDialog({ kind: 'settings', tab: 'advanced' })}>Set tool locations manually</Button>
        </div>
      </div>
    </div>
  );
}
