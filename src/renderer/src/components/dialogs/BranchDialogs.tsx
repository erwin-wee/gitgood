import React, { useEffect, useMemo, useState } from 'react';
import type { Branch, Commit } from '@shared/types';
import { compareStrings, isValidBranchName, sanitizeBranchName } from '@shared/util';
import { errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, useAppStore } from '../../state/store';
import { Button, Callout, Checkbox, Dialog, FilterInput, Icon, RelativeTime, Spinner, TextField, useFilter } from '../ui';

const branchKeys = (b: Branch) => [b.name, b.lastCommitSubject];

export function NewBranchDialog({ startPoint, startPointLabel, initialName }: { startPoint?: string | null; startPointLabel?: string; initialName?: string }): React.JSX.Element {
  const status = useAppStore((s) => s.status);
  const defaultBranch = useAppStore((s) => s.defaultBranch);
  const branches = useAppStore((s) => s.branches);
  const repo = useAppStore((s) => s.currentRepo);
  const [name, setName] = useState(initialName ?? '');
  const [base, setBase] = useState<'current' | 'default' | 'commit'>(startPoint ? 'commit' : 'current');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const sanitized = sanitizeBranchName(name);
  const exists = branches.some((b) => b.kind === 'local' && b.name === sanitized);
  const valid = sanitized.length > 0 && isValidBranchName(sanitized) && !exists;
  const current = status?.branch.name ?? null;
  const showBaseChoice = !startPoint && defaultBranch && current && current !== defaultBranch;

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    const point = base === 'commit' ? startPoint ?? null : base === 'default' ? defaultBranch : null;
    await actions.createBranch(sanitized, point, checkout);
    setBusy(false);
  };

  return (
    <Dialog
      title="Create a branch"
      icon="branch"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!valid} loading={busy}>Create branch</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          spellCheck={false}
          hint={sanitized && sanitized !== name.trim() ? `Will be created as ${sanitized}` : undefined}
          error={exists ? 'A branch with this name already exists.' : name && !valid && sanitized ? 'That name is not a valid branch name.' : undefined}
        />
      </form>
      {repo?.github ? (
        <p className="muted" style={{ marginTop: -4 }}>
          <Button variant="link" onClick={() => openDialog({ kind: 'issues' })}>Pick an issue…</Button> to name this branch after it.
        </p>
      ) : null}
      {startPoint ? (
        <Callout tone="info" icon="commit">
          Based on commit <span className="mono">{startPointLabel ?? startPoint.slice(0, 7)}</span>
        </Callout>
      ) : showBaseChoice ? (
        <div className="field">
          <label>Create branch based on…</label>
          <label className="radio-option">
            <input type="radio" checked={base === 'default'} onChange={() => setBase('default')} />
            <span>
              <strong>{defaultBranch}</strong>
              <span>The default branch in your repository. Pick this to start something new that is not dependent on your current branch.</span>
            </span>
          </label>
          <label className="radio-option">
            <input type="radio" checked={base === 'current'} onChange={() => setBase('current')} />
            <span>
              <strong>{current}</strong>
              <span>The currently checked out branch. Pick this if you need to build on work done on this branch.</span>
            </span>
          </label>
        </div>
      ) : (
        <p className="muted">Your new branch will be based on your currently checked out branch{current ? ` (${current})` : ''}.</p>
      )}
      <Checkbox checked={checkout} onChange={setCheckout} label="Switch to the new branch" />
    </Dialog>
  );
}

export function RenameBranchDialog({ branch }: { branch: string }): React.JSX.Element {
  const branches = useAppStore((s) => s.branches);
  const [name, setName] = useState(branch);
  const [busy, setBusy] = useState(false);
  const sanitized = sanitizeBranchName(name);
  const exists = sanitized !== branch && branches.some((b) => b.kind === 'local' && b.name === sanitized);
  const valid = sanitized.length > 0 && isValidBranchName(sanitized) && !exists && sanitized !== branch;
  const target = branches.find((b) => b.kind === 'local' && b.name === branch);
  return (
    <Dialog
      title={`Rename ${branch}`}
      icon="branch"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={async () => { setBusy(true); await actions.renameBranch(branch, sanitized); setBusy(false); }}>Rename</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (valid) void actions.renameBranch(branch, sanitized); }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} error={exists ? 'A branch with this name already exists.' : undefined} />
      </form>
      {target?.upstream ? <Callout tone="warning">This branch is published as <span className="mono">{target.upstream}</span>. Renaming it locally does not rename the remote branch; publish the renamed branch and delete the old remote branch when you are ready.</Callout> : null}
    </Dialog>
  );
}

export function DeleteBranchDialog({ branch }: { branch: Branch }): React.JSX.Element {
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = useAppStore((s) => s.status);
  const unmerged = status?.branch.name && branch.kind === 'local' ? null : null;
  void unmerged;
  return (
    <Dialog
      title={`Delete ${branch.name}`}
      icon="trash"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={async () => { setBusy(true); await actions.deleteBranch(branch, remote); setBusy(false); }}>Delete</Button>
        </>
      }
    >
      <p>
        Are you sure you want to delete {branch.kind === 'remote' ? 'the remote branch' : 'the branch'} <strong>{branch.name}</strong>? This action cannot be undone.
      </p>
      {branch.kind === 'local' && branch.upstream ? <Checkbox checked={remote} onChange={setRemote} label={`Also delete the branch on the remote (${branch.upstream})`} /> : null}
      {branch.kind === 'remote' ? <Callout tone="warning">This deletes the branch on the remote for everyone.</Callout> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Branch picker (merge / rebase / cherry-pick target)
// ---------------------------------------------------------------------------

export function BranchPicker({ branches, selected, onSelect, exclude }: { branches: Branch[]; selected: Branch | null; onSelect: (b: Branch) => void; exclude?: (b: Branch) => boolean }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const list = useMemo(() => branches.filter((b) => !exclude?.(b)).sort((a, b) => (a.kind === b.kind ? new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime() : a.kind === 'local' ? -1 : 1)), [branches, exclude]);
  const filtered = useFilter(list, query, branchKeys);
  return (
    <div className="branch-picker">
      <div className="popover-header">
        <FilterInput value={query} onChange={setQuery} placeholder="Filter branches" autoFocus />
      </div>
      <div className="popover-list">
        {filtered.length === 0 ? <div className="list-empty">No branches match.</div> : null}
        {filtered.map((b) => (
          <div key={`${b.kind}:${b.name}`} className={`list-row ${selected?.name === b.name && selected.kind === b.kind ? 'selected' : ''}`} onClick={() => onSelect(b)}>
            <Icon name={b.kind === 'remote' ? 'globe' : 'branch'} />
            <span className="row-main">
              <span className="truncate">{b.name}</span>
              <span className="row-sub truncate">{b.lastCommitSubject}</span>
            </span>
            <span className="row-meta">
              <RelativeTime date={b.lastCommitDate} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function useCompare(base: string | null, head: string | null): { ahead: Commit[]; behind: Commit[]; loading: boolean; error: string | null } {
  const repo = useAppStore((s) => s.currentRepo);
  const [state, setState] = useState<{ ahead: Commit[]; behind: Commit[]; loading: boolean; error: string | null }>({ ahead: [], behind: [], loading: false, error: null });
  useEffect(() => {
    if (!repo || !base || !head) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    void invoke('repo.compare', repo.path, base, head)
      .then((r) => !cancelled && setState({ ...r, loading: false, error: null }))
      .catch((err) => !cancelled && setState({ ahead: [], behind: [], loading: false, error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [repo, base, head]);
  return state;
}

export function MergeDialog({ squash, preselect, rebase }: { squash: boolean; preselect?: string; rebase?: boolean }): React.JSX.Element {
  const branches = useAppStore((s) => s.branches);
  const status = useAppStore((s) => s.status);
  const current = status?.branch.name ?? 'HEAD';
  const [selected, setSelected] = useState<Branch | null>(() => branches.find((b) => b.name === preselect) ?? null);
  const compare = useCompare(current, selected?.name ?? null);
  const [busy, setBusy] = useState(false);
  const title = rebase ? `Rebase ${current}` : squash ? `Squash and merge into ${current}` : `Merge into ${current}`;
  const verb = rebase ? 'Rebase' : squash ? 'Squash and merge' : 'Merge';
  const run = async () => {
    if (!selected) return;
    setBusy(true);
    if (rebase) await actions.rebaseOnto(selected.name);
    else await actions.mergeBranch(selected.name, squash);
    setBusy(false);
  };
  const n = compare.ahead.length;
  return (
    <Dialog
      title={title}
      icon={rebase ? 'branch' : 'merge'}
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <span className="left muted" style={{ fontSize: 12 }}>
            {selected && compare.loading ? <Spinner /> : null}
            {selected && !compare.loading && !compare.error
              ? rebase
                ? `This will rebase ${compare.behind.length} commit${compare.behind.length === 1 ? '' : 's'} from ${current} onto ${selected.name}.`
                : n === 0
                  ? `${current} is already up to date with ${selected.name}.`
                  : `This will ${squash ? 'squash' : 'merge'} ${n}${n >= 200 ? '+' : ''} commit${n === 1 ? '' : 's'} from ${selected.name} into ${current}.`
              : null}
            {compare.error ? <span style={{ color: 'var(--danger)' }}>{compare.error}</span> : null}
          </span>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!selected || (!rebase && n === 0 && !compare.loading)} loading={busy} onClick={() => void run()}>
            {verb} {selected ? selected.name : ''}
          </Button>
        </>
      }
    >
      <BranchPicker branches={branches} selected={selected} onSelect={setSelected} exclude={(b) => b.isCurrent} />
      {rebase && status && status.files.length ? <Callout tone="warning">You have uncommitted changes. Commit or stash them before rebasing.</Callout> : null}
    </Dialog>
  );
}

export function CompareDialog(): React.JSX.Element {
  const branches = useAppStore((s) => s.branches);
  const status = useAppStore((s) => s.status);
  const repo = useAppStore((s) => s.currentRepo);
  const current = status?.branch.name ?? 'HEAD';
  const [selected, setSelected] = useState<Branch | null>(null);
  const compare = useCompare(selected?.name ?? null, current);
  return (
    <Dialog title={`Compare ${current} to…`} icon="branch" onClose={closeDialog} width="xwide" footer={<Button onClick={closeDialog}>Close</Button>}>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
        <BranchPicker branches={branches} selected={selected} onSelect={setSelected} exclude={(b) => b.isCurrent} />
        <div>
          {!selected ? (
            <p className="muted">Pick a branch to see which commits differ.</p>
          ) : compare.loading ? (
            <Spinner />
          ) : (
            <div className="compare-columns">
              <div>
                <h4>
                  <Icon name="arrow-up" size={12} /> {compare.ahead.length} ahead — only on {current}
                </h4>
                <ul>
                  {compare.ahead.map((c) => (
                    <li key={c.sha} title={c.summary}>
                      <span className="mono muted">{c.shortSha}</span> {c.summary}
                    </li>
                  ))}
                  {compare.ahead.length === 0 ? <li className="muted">Nothing</li> : null}
                </ul>
              </div>
              <div>
                <h4>
                  <Icon name="arrow-down" size={12} /> {compare.behind.length} behind — only on {selected.name}
                </h4>
                <ul>
                  {compare.behind.map((c) => (
                    <li key={c.sha} title={c.summary}>
                      <span className="mono muted">{c.shortSha}</span> {c.summary}
                    </li>
                  ))}
                  {compare.behind.length === 0 ? <li className="muted">Nothing</li> : null}
                </ul>
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
                <Button size="sm" icon="merge" onClick={() => { closeDialog(); void actions.mergeBranch(selected.name, false); }} disabled={compare.behind.length === 0}>Merge {selected.name} into {current}</Button>
                {repo?.github ? <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(`${repo.github!.url}/compare/${encodeURIComponent(selected.name.replace(/^origin\//, ''))}...${encodeURIComponent(current)}`)}>Compare on GitHub</Button> : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function CherryPickDialog({ shas }: { shas: string[] }): React.JSX.Element {
  const branches = useAppStore((s) => s.branches);
  const [selected, setSelected] = useState<Branch | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`Cherry-pick ${shas.length} commit${shas.length === 1 ? '' : 's'} to…`}
      icon="cherry"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!selected} loading={busy} onClick={async () => { if (!selected) return; setBusy(true); await actions.cherryPickTo(shas, selected); setBusy(false); }}>Cherry-pick to {selected?.name ?? 'branch'}</Button>
        </>
      }
    >
      <p className="muted">The target branch is checked out first, then the commits are applied in order.</p>
      <BranchPicker branches={branches.filter((b) => b.kind === 'local')} selected={selected} onSelect={setSelected} />
    </Dialog>
  );
}

export function UncommittedChangesDialog({ targetLabel, proceed }: { targetLabel: string; proceed: (strategy: 'stash' | 'move') => Promise<void> }): React.JSX.Element {
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const [choice, setChoice] = useState<'stash' | 'move'>('stash');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = status?.branch.name ?? 'the current branch';
  const count = status?.files.length ?? 0;
  const go = async () => {
    setBusy(true);
    if (remember) void actions.updateSettings({ uncommittedChangesStrategy: choice });
    closeDialog();
    await proceed(choice);
    setBusy(false);
  };
  return (
    <Dialog
      title="Switch branch"
      icon="branch"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void go()}>Switch branch</Button>
        </>
      }
    >
      <p>
        You have {count} uncommitted change{count === 1 ? '' : 's'} on <strong>{current}</strong>. What would you like to do with them when switching to <strong>{targetLabel}</strong>?
      </p>
      <label className="radio-option">
        <input type="radio" checked={choice === 'stash'} onChange={() => setChoice('stash')} />
        <span>
          <strong>Leave my changes on {current}</strong>
          <span>Your in-progress work is stashed on this branch so you can pick it back up later.</span>
        </span>
      </label>
      <label className="radio-option">
        <input type="radio" checked={choice === 'move'} onChange={() => setChoice('move')} />
        <span>
          <strong>Bring my changes to {targetLabel}</strong>
          <span>Your in-progress work follows you to the new branch.</span>
        </span>
      </label>
      {settings ? <Checkbox checked={remember} onChange={setRemember} label="Always do this without asking (change later in Options → Prompts)" /> : null}
    </Dialog>
  );
}

export function branchesSorted(branches: Branch[]): Branch[] {
  return [...branches].sort((a, b) => compareStrings(a.name, b.name));
}
