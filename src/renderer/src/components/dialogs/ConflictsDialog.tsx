import React from 'react';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Button, Callout, Dialog, Icon, PathLabel, Spinner } from '../ui';

export function ConflictsDialog(): React.JSX.Element {
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const ai = useAppStore((s) => s.ai);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const operation = status?.operation ?? null;
  const conflicted = status?.files.filter((f) => f.conflict) ?? [];
  const kind = operation?.kind ?? 'none';
  const aiEnabled = settings?.ai.provider !== 'disabled';
  const opLabel = kind === 'merge' ? `merging ${operation?.targetName ?? 'branch'} into ${status?.branch.name ?? 'current branch'}` : kind === 'rebase' ? `rebasing ${operation?.headName ?? 'branch'} onto ${operation?.ontoName ?? operation?.onto?.slice(0, 7) ?? 'target'}` : kind === 'cherry-pick' ? `cherry-picking ${operation?.targetSha?.slice(0, 7) ?? ''}` : kind === 'revert' ? `reverting ${operation?.targetSha?.slice(0, 7) ?? ''}` : 'this operation';
  const done = conflicted.length === 0;
  const continueLabel = kind === 'merge' ? 'Commit merge' : kind === 'rebase' ? 'Continue rebase' : kind === 'cherry-pick' ? 'Continue cherry-pick' : kind === 'revert' ? 'Continue revert' : 'Continue';

  return (
    <Dialog
      title={done ? `Resolved conflicts` : `Resolve conflicts before ${opLabel}`}
      icon={done ? 'check-circle' : 'alert'}
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <span className="left">
            {kind !== 'none' ? <Button variant="danger" onClick={() => void actions.abortOperation()}>Abort {kind}</Button> : null}
          </span>
          <Button onClick={closeDialog}>Close</Button>
          {kind === 'rebase' && !done ? <Button onClick={() => void actions.skipRebaseCommit()}>Skip this commit</Button> : null}
          {kind !== 'none' ? <Button variant="primary" disabled={!done} onClick={() => void actions.continueOperation()}>{continueLabel}</Button> : null}
        </>
      }
    >
      {done ? (
        <Callout tone="success">All conflicts are resolved. {kind !== 'none' ? `Click “${continueLabel}” to finish.` : ''}</Callout>
      ) : (
        <>
          <p>
            {conflicted.length} file{conflicted.length === 1 ? ' has' : 's have'} conflicts. Resolve them with AI, pick a side, or edit the files in your editor, then mark them as resolved.
          </p>
          {aiEnabled ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <Button variant="accent" icon="sparkle" loading={aiBusy} onClick={() => void actions.resolveAllWithAi()}>
                Resolve all {conflicted.length > 1 ? `${conflicted.length} files ` : ''}with AI
              </Button>
              <span className="muted" style={{ fontSize: 12 }}>
                Uses {settings?.ai.provider === 'claude-cli' ? 'Claude Code' : settings?.ai.model}; every resolution stays reviewable in the diff and can be undone.
              </span>
            </div>
          ) : (
            <Callout tone="info">
              Enable AI in <Button variant="link" onClick={() => actions.openDialog({ kind: 'settings', tab: 'ai' })}>Options → AI</Button> to resolve conflicts with one click.
            </Callout>
          )}
        </>
      )}
      <div className="file-list" style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 320 }}>
        {conflicted.map((f) => {
          const state = ai[f.path];
          const textual = f.conflict === 'both-modified' || f.conflict === 'both-added';
          return (
            <div key={f.path} className="file-row" style={{ height: 'auto', padding: '6px 10px' }}>
              <Icon name="alert" className="status-icon conflicted" />
              <span className="row-main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <PathLabel path={f.path} />
                <span className="row-sub">
                  {f.conflict?.replace(/-/g, ' ')}
                  {state && state.phase !== 'done' ? (
                    <span className="ai-status" style={{ marginLeft: 8 }}>
                      {state.phase === 'error' ? <Icon name="x-circle" size={12} /> : <Spinner />} {state.message}
                    </span>
                  ) : null}
                </span>
              </span>
              <span style={{ display: 'inline-flex', gap: 4 }}>
                {aiEnabled && textual ? <Button size="sm" variant="accent" icon="sparkle" onClick={() => void actions.resolveWithAi(f.path)} disabled={aiBusy} title="Resolve with AI">AI</Button> : null}
                <Button size="sm" onClick={() => void actions.useSide(f.path, 'ours')} title={kind === 'rebase' ? 'Keep the upstream version' : 'Keep the current branch version'}>Ours</Button>
                <Button size="sm" onClick={() => void actions.useSide(f.path, 'theirs')} title={kind === 'rebase' ? 'Keep your commit’s version' : 'Keep the incoming version'}>Theirs</Button>
                <Button size="sm" variant="ghost" icon="pencil" title="Open in editor" onClick={() => void actions.openInEditor(f.path)} />
                <Button size="sm" variant="ghost" icon="check" title="Mark as resolved" onClick={() => void actions.markResolved([f.path])} />
              </span>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
