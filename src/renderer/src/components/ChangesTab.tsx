import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitFile, ReviewFinding, ReviewSeverity, WorkingFile } from '@shared/types';
import { extname } from '@shared/util';
import { invoke, isMac } from '../api';
import * as actions from '../state/actions';
import { openDialog, patchChanges, store, useAppStore } from '../state/store';
import { liveFindings, SEVERITY_ICON, SEVERITY_TONE } from './review/ReviewView';
import { Avatar, Button, Checkbox, Icon, PathLabel, Spinner, openContextMenu, statusIcon, statusLabel, type MenuItem } from './ui';

const SUMMARY_LIMIT = 72;

export function ChangesTab(): React.JSX.Element {
  const status = useAppStore((s) => s.status);
  const changes = useAppStore((s) => s.changes);
  const stashes = useAppStore((s) => s.stashes);
  const focused = useAppStore((s) => s.focused);
  const ai = useAppStore((s) => s.ai);
  const [filter, setFilter] = useState('');
  const files = status?.files ?? [];
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  const includedCount = files.filter((f) => !changes.excluded.includes(f.path)).length;
  const partialCount = Object.keys(changes.partial).length;
  const allState: boolean | 'indeterminate' = files.length === 0 ? false : includedCount === files.length && partialCount === 0 ? true : includedCount === 0 ? false : 'indeterminate';

  const contextMenu = (e: React.MouseEvent, file: WorkingFile) => {
    const s = store.get();
    const selected = s.changes.selectedPaths.includes(file.path) ? s.changes.selectedPaths : [file.path];
    if (!s.changes.selectedPaths.includes(file.path)) actions.selectWorkingFile(file.path);
    const ext = extname(file.path);
    const items: MenuItem[] = [];
    if (file.conflict) {
      items.push(
        { label: 'Resolve with AI', icon: 'sparkle', onClick: () => void actions.resolveWithAi(file.path), disabled: s.settings?.ai.provider === 'disabled' || s.aiBusy },
        { label: `Use ${s.status?.operation.kind === 'rebase' ? 'upstream' : 'current branch'} version (ours)`, onClick: () => void actions.useSide(file.path, 'ours') },
        { label: `Use ${s.status?.operation.kind === 'rebase' ? 'rebased commit' : 'incoming'} version (theirs)`, onClick: () => void actions.useSide(file.path, 'theirs') },
        { label: 'Mark as resolved', onClick: () => void actions.markResolved([file.path]) },
        { type: 'separator' },
      );
    }
    items.push(
      { label: selected.length > 1 ? `Discard ${selected.length} selected changes…` : 'Discard changes…', danger: true, onClick: () => actions.requestDiscard(selected, false) },
      { label: 'Discard all changes…', danger: true, onClick: () => actions.requestDiscard(files.map((f) => f.path), true) },
      { type: 'separator' },
      { label: 'Blame this file', onClick: () => { actions.selectWorkingFile(file.path); actions.toggleBlame(); }, disabled: file.status === 'untracked' || !!file.submodule || !!file.conflict },
      { label: 'File history…', onClick: () => actions.openFileHistory(file.path) },
      { type: 'separator' },
      { label: selected.length > 1 ? 'Include selected in commit' : 'Include in commit', onClick: () => patchChanges((c) => ({ excluded: c.excluded.filter((p) => !selected.includes(p)) })) },
      { label: selected.length > 1 ? 'Exclude selected from commit' : 'Exclude from commit', onClick: () => patchChanges((c) => ({ excluded: [...new Set([...c.excluded, ...selected])], partial: Object.fromEntries(Object.entries(c.partial).filter(([p]) => !selected.includes(p))) })) },
      { type: 'separator' },
      { label: 'Ignore file (add to .gitignore)', onClick: () => void actions.ignore(selected.map((p) => `/${p}`)) },
      ...(ext ? [{ label: `Ignore all ${ext} files (add to .gitignore)`, onClick: () => void actions.ignore([`*${ext}`]) }] : []),
      { type: 'separator' },
      { label: isMac ? 'Reveal in Finder' : 'Show in Explorer', onClick: () => void actions.showInFolder(file.status === 'deleted' ? null : file.path), shortcut: `${isMac ? '⌘' : 'Ctrl'}+Shift+F` },
      { label: 'Open in external editor', onClick: () => void actions.openInEditor(file.status === 'deleted' ? null : file.path), disabled: file.status === 'deleted', shortcut: `${isMac ? '⌘' : 'Ctrl'}+Shift+A` },
      { label: 'Open with default program', onClick: () => void invoke('app.joinPath', s.currentRepo!.path, ...file.path.split('/')).then((p) => invoke('app.openPath', p)), disabled: file.status === 'deleted' },
      { type: 'separator' },
      { label: 'Copy file path', onClick: () => void invoke('app.joinPath', s.currentRepo!.path, ...file.path.split('/')).then((p) => actions.copyToClipboard(p, 'Path copied')) },
      { label: 'Copy relative file path', onClick: () => void actions.copyToClipboard(file.path, 'Path copied') },
      { type: 'separator' },
      { label: selected.length > 1 ? `Stash ${selected.length} selected files…` : 'Stash selected files…', onClick: () => openDialog({ kind: 'stash-selected-files', paths: selected }) },
    );
    openContextMenu(e, items);
  };

  return (
    <>
      <div className="changes-header">
        <Checkbox checked={allState} onChange={(v) => actions.setAllIncluded(v)} disabled={files.length === 0 || !!status?.hasConflicts} title="Include all changes in commit" />
        <span className="count">
          {files.length === 0 ? 'No changes' : `${files.length} changed file${files.length === 1 ? '' : 's'}`}
          {status?.hasConflicts ? <span className="muted"> · {files.filter((f) => f.conflict).length} conflicted</span> : null}
        </span>
        {files.length > 8 ? (
          <span className="filter-input" style={{ flex: '0 0 130px' }}>
            <Icon name="filter" />
            <input id="changes-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: '2px 4px 2px 26px', fontSize: 12 }} />
          </span>
        ) : null}
      </div>
      <div className="file-list" onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.file-row')) return; if (files.length) openContextMenu(e, [{ label: 'Discard all changes…', danger: true, onClick: () => actions.requestDiscard(files.map((f) => f.path), true) }, { label: 'Stash all changes', onClick: () => void actions.stashAll() }]); }}>
        {status && files.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <Icon name="check-circle" size={28} />
            <p>{status.branch.unborn ? 'This repository has no commits yet. Add some files to make your first commit.' : 'No local changes.'}</p>
          </div>
        ) : null}
        {visible.map((file) => {
          const included = changes.excluded.includes(file.path) ? false : changes.partial[file.path] ? 'indeterminate' : true;
          const selected = changes.selectedPaths.includes(file.path);
          const aiState = ai[file.path];
          return (
            <div
              key={file.path}
              className={`file-row ${selected ? 'selected' : ''} ${selected && !focused ? 'inactive' : ''}`}
              onClick={(e) => actions.selectWorkingFile(file.path, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
              onContextMenu={(e) => contextMenu(e, file)}
              onDoubleClick={() => void actions.openInEditor(file.path)}
            >
              <Checkbox checked={included} onChange={() => actions.toggleIncluded(file.path)} disabled={!!file.conflict} title={file.conflict ? 'Resolve the conflict before committing' : included === true ? 'Exclude from commit' : 'Include in commit'} />
              <PathLabel path={file.path} />
              {aiState && aiState.phase !== 'done' && aiState.phase !== 'error' ? <Spinner /> : null}
              {file.conflict ? <span className="badge danger" title={file.conflict.replace(/-/g, ' ')}>conflict</span> : null}
              {file.lfs ? <Icon name="download" size={12} className="muted" title="Git LFS pointer" /> : null}
              <span className={`status-icon ${file.status}`} title={file.status === 'renamed' && file.oldPath ? `Renamed from ${file.oldPath}` : statusLabel(file.status)}>
                <Icon name={statusIcon(file.status)} />
              </span>
            </div>
          );
        })}
      </div>
      {stashes.length ? (
        <button type="button" className="stash-nav-button" onClick={() => actions.setView('stashes')} title="Open the Stashes view">
          <Icon name="stash" />
          <span>{stashes.length} stash{stashes.length === 1 ? '' : 'es'}</span>
          <Icon name="chevron-right" size={12} />
        </button>
      ) : null}
      <PrecommitFindingsStrip />
      <CommitForm />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pre-commit AI review findings strip
// ---------------------------------------------------------------------------

function PrecommitFindingsStrip(): React.JSX.Element | null {
  const review = useAppStore((s) => s.precommitReview);
  const run = review.run;
  // Subscribed so turning the AI provider off hides the Fix with agent action immediately.
  useAppStore((s) => s.settings?.ai.provider);
  const findings = useMemo(() => liveFindings(run), [run]);
  if (!run && !review.running) return null;

  if (!run) {
    return (
      <div className="precommit-strip">
        <Spinner />
        <span className="muted">{review.progress?.message ?? 'Reviewing changes…'}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => actions.cancelPrecommitReview()}>Cancel</Button>
      </div>
    );
  }

  const counts = { blocker: 0, warning: 0, nit: 0 } as Record<ReviewSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  const staleCount = review.stalePaths.length;
  const reviewedFiles = run.files.filter((f) => f.status === 'reviewed').length;

  return (
    <div className={`precommit-strip ${review.expanded ? 'expanded' : ''}`}>
      <button type="button" className="precommit-strip-header" onClick={() => actions.togglePrecommitReviewStrip()}>
        <Icon name="sparkle" />
        {review.running ? <Spinner /> : null}
        {counts.blocker ? <span className="finding-count danger" title={`${counts.blocker} blocker${counts.blocker === 1 ? '' : 's'}`}>{counts.blocker}</span> : null}
        {counts.warning ? <span className="finding-count attention" title={`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`}>{counts.warning}</span> : null}
        {counts.nit ? <span className="finding-count neutral" title={`${counts.nit} nit${counts.nit === 1 ? '' : 's'}`}>{counts.nit}</span> : null}
        <span className="muted truncate" style={{ flex: 1, textAlign: 'left' }}>{findings.length ? run.summary || `${findings.length} finding${findings.length === 1 ? '' : 's'}` : `No issues found in ${reviewedFiles} file${reviewedFiles === 1 ? '' : 's'}`}</span>
        {staleCount ? <span className="badge attention" title="Some reviewed files changed since this run">{staleCount} stale</span> : null}
        <Icon name={review.expanded ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {review.expanded ? (
        <div className="precommit-strip-body">
          {findings.map((f) => (
            <PrecommitFindingRow key={f.id} finding={f} stale={review.stalePaths.includes(f.path)} active={review.activeFindingId === f.id} />
          ))}
          {!findings.length ? <div className="list-empty">Nothing to flag in the reviewed files.</div> : null}
          <div className="precommit-strip-actions">
            {run.droppedInvalid ? <span className="muted" style={{ fontSize: 11 }}>{run.droppedInvalid} candidate{run.droppedInvalid === 1 ? '' : 's'} dropped by validation</span> : null}
            <span style={{ flex: 1 }} />
            {staleCount ? <Button size="sm" variant="ghost" icon="sync" onClick={() => void actions.rereviewStalePrecommitFindings()} disabled={review.running}>Re-review {staleCount} stale file{staleCount === 1 ? '' : 's'}</Button> : null}
            {actions.agentHandoffAvailable(run) ? <Button size="sm" variant="ghost" icon="terminal" className="fix-with-agent" onClick={() => void actions.fixWithAgent(run)} disabled={review.running} title="Write the findings to .git/gitgood/review and open your terminal running the configured coding agent on them">Fix with agent</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PrecommitFindingRow({ finding, stale, active }: { finding: ReviewFinding; stale: boolean; active: boolean }): React.JSX.Element {
  return (
    <div className={`finding-row ${active ? 'active' : ''} ${stale ? 'stale' : ''}`} onClick={() => actions.focusPrecommitFinding(finding)} title={stale ? 'This file changed since the review; re-review to refresh.' : finding.detail}>
      <Icon name={SEVERITY_ICON[finding.severity]} className={`finding-icon ${SEVERITY_TONE[finding.severity]}`} />
      <span className="finding-main">
        <span className="finding-title truncate">{finding.title}</span>
        <span className="finding-sub truncate">
          <span className="mono">{finding.path}:{finding.line}{finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : ''}</span> · {finding.category}
          {stale ? ' · stale' : ''}
        </span>
      </span>
      <Button size="sm" variant="ghost" iconOnly icon="x" title="Dismiss" onClick={(e) => { e.stopPropagation(); void actions.dismissPrecommitFinding(finding); }} />
    </div>
  );
}

export function CommitFileRow({ file, selected, onSelect, onContextMenu }: { file: CommitFile; selected: boolean; onSelect: () => void; onContextMenu?: (e: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <div className={`file-row ${selected ? 'selected' : ''}`} onClick={onSelect} onContextMenu={onContextMenu}>
      <PathLabel path={file.path} />
      {file.lfs ? <Icon name="download" size={12} className="muted" title="Git LFS pointer" /> : null}
      {file.additions !== null || file.deletions !== null ? (
        <span className="stats">
          {file.additions ? <span className="stat-add">+{file.additions}</span> : null}
          {file.deletions ? <span className="stat-del">−{file.deletions}</span> : null}
        </span>
      ) : null}
      <span className={`status-icon ${file.status}`} title={file.status === 'renamed' && file.oldPath ? `Renamed from ${file.oldPath}` : statusLabel(file.status)}>
        <Icon name={statusIcon(file.status)} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit form
// ---------------------------------------------------------------------------

function CommitForm(): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const changes = useAppStore((s) => s.changes);
  const settings = useAppStore((s) => s.settings);
  const aiCommitBusy = useAppStore((s) => s.aiCommitBusy);
  const precommitReview = useAppStore((s) => s.precommitReview);
  const precommitFindings = useMemo(() => liveFindings(precommitReview.run), [precommitReview.run]);
  const precommitBlockers = precommitFindings.filter((f) => f.severity === 'blocker').length;
  const signingConfigVersion = useAppStore((s) => s.signingConfigVersion);
  const [identity, setIdentity] = useState<{ name: string | null; email: string | null } | null>(null);
  const [willSign, setWillSign] = useState(false);
  const [coAuthorInput, setCoAuthorInput] = useState('');
  const summaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    void invoke('repo.config', repo.path)
      .then((c) => !cancelled && setIdentity(c.effective))
      .catch(() => undefined);
    void invoke('repo.signing.get', repo.path)
      .then((s) => !cancelled && setWillSign(s.effective.signCommits))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo, signingConfigVersion]);

  const files = status?.files ?? [];
  const included = files.filter((f) => !changes.excluded.includes(f.path));
  const inMerge = status?.operation.kind === 'merge' || status?.operation.kind === 'cherry-pick' || status?.operation.kind === 'revert';
  const summaryTooLong = changes.summary.length > SUMMARY_LIMIT;
  const branchName = status?.branch.name ?? 'HEAD';
  const canCommit = !!status && !changes.committing && !status.hasConflicts && (changes.amend || (included.length > 0 && (changes.summary.trim().length > 0 || inMerge)));
  const label = changes.committing ? 'Committing…' : changes.amend ? 'Amend last commit' : inMerge ? `Commit ${status?.operation.kind === 'merge' ? 'merge' : status?.operation.kind}` : status?.branch.detached ? 'Commit to detached HEAD' : `Commit to ${branchName}`;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) {
      e.preventDefault();
      void actions.commit();
    }
  };

  const addCoAuthor = () => {
    const text = coAuthorInput.trim();
    if (!text) return;
    const m = /^(.*?)\s*<([^>]+)>$/.exec(text);
    const entry = m ? { name: m[1].trim() || m[2].split('@')[0], email: m[2].trim() } : text.includes('@') ? { name: text.split('@')[0], email: text } : null;
    if (!entry) return;
    patchChanges((c) => ({ coAuthors: c.coAuthors.some((a) => a.email === entry.email) ? c.coAuthors : [...c.coAuthors, entry] }));
    setCoAuthorInput('');
  };

  const placeholderSummary = inMerge && status?.operation.message ? status.operation.message.split('\n')[0] : 'Summary (required)';

  return (
    <form
      className="commit-form"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        if (canCommit) void actions.commit();
      }}
    >
      <div className="summary-row">
        <Avatar email={identity?.email ?? ''} name={identity?.name ?? undefined} size={24} />
        <input
          id="commit-summary"
          ref={summaryRef}
          className={summaryTooLong ? 'warn' : ''}
          placeholder={placeholderSummary}
          value={changes.summary}
          onChange={(e) => patchChanges({ summary: e.target.value })}
          disabled={changes.committing}
          spellCheck
          autoComplete="off"
        />
        {willSign ? <Icon name="lock" size={14} className="muted" title="Commits are signed" /> : null}
        {settings?.ai.provider !== 'disabled' ? (
          <Button variant="ghost" iconOnly icon="sparkle" className="sparkle" loading={aiCommitBusy} title="Generate commit message with AI" onClick={() => void actions.generateCommitMessage()} disabled={included.length === 0 || changes.committing} />
        ) : null}
        {settings?.ai.provider !== 'disabled' ? (
          <Button variant="ghost" iconOnly icon="eye" loading={precommitReview.running} title="Review changes with AI before committing" onClick={() => void actions.reviewChangesBeforeCommit()} disabled={included.length === 0 || changes.committing} />
        ) : null}
        {actions.splitEntryVisible() ? (
          <Button
            variant="ghost"
            iconOnly
            icon="kebab"
            title="More AI actions"
            disabled={changes.committing}
            onClick={(e) =>
              openContextMenu(e, [
                {
                  label: 'Split into commits with AI…',
                  icon: 'sparkle',
                  disabled: !actions.splitEntryEnabled(),
                  title: actions.splitEntryEnabled() ? undefined : 'At least two changed files are needed to split into commits.',
                  onClick: () => actions.openSplitDialog(),
                },
              ])
            }
          />
        ) : null}
      </div>
      {summaryTooLong && settings?.showCommitLengthWarning !== false ? (
        <span className="length-warning">
          <Icon name="alert" size={12} /> Great commit summaries are 72 characters or fewer ({changes.summary.length}).
        </span>
      ) : null}
      {precommitReview.run?.commitMessageMatches === false ? (
        <span className="length-warning">
          <Icon name="alert" size={12} /> {precommitReview.run.commitMessageNote || 'The commit message may not match the diff.'}
        </span>
      ) : null}
      <textarea placeholder="Description" value={changes.description} onChange={(e) => patchChanges({ description: e.target.value })} disabled={changes.committing} spellCheck />
      {changes.showCoAuthors ? (
        <div className="coauthors">
          {changes.coAuthors.map((a) => (
            <span key={a.email} className="coauthor-chip" title={a.email}>
              {a.name}
              <button type="button" onClick={() => patchChanges((c) => ({ coAuthors: c.coAuthors.filter((x) => x.email !== a.email) }))} title="Remove">
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <input
            style={{ flex: 1, minWidth: 140, padding: '2px 6px', fontSize: 12 }}
            placeholder="Co-author: Name <email>"
            value={coAuthorInput}
            onChange={(e) => setCoAuthorInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addCoAuthor();
              }
            }}
            onBlur={addCoAuthor}
          />
        </div>
      ) : null}
      <div className="form-actions">
        <div className="left">
          <Button variant="ghost" size="sm" icon="person" title={changes.showCoAuthors ? 'Remove co-authors' : 'Add co-authors'} onClick={() => patchChanges((c) => ({ showCoAuthors: !c.showCoAuthors }))} />
          {repo?.github ? <Button variant="ghost" size="sm" icon="issue" title="Reference an issue" onClick={() => actions.openIssuesDialog()}>#</Button> : null}
          <Checkbox checked={changes.amend} onChange={(v) => void actions.setAmend(v)} label="Amend last commit" disabled={changes.committing || !!status?.branch.unborn || inMerge} />
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {included.length} of {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>
      <Button
        type="submit"
        variant={precommitBlockers ? 'danger' : 'primary'}
        className={`commit-btn ${precommitBlockers ? 'has-blockers' : ''}`}
        disabled={!canCommit}
        loading={changes.committing}
        icon={changes.amend ? 'pencil' : 'commit'}
        title={precommitBlockers ? `${precommitBlockers} blocker${precommitBlockers === 1 ? '' : 's'} found, review before committing` : `${isMac ? '⌘' : 'Ctrl'}+Enter`}
      >
        {label}
      </Button>
      {status?.hasConflicts ? (
        <Button variant="ghost" size="sm" icon="alert" onClick={() => openDialog({ kind: 'conflicts' })}>
          Resolve conflicts before committing
        </Button>
      ) : null}
    </form>
  );
}
