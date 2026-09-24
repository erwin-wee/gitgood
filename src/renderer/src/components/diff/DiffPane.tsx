import React, { memo, useCallback, useMemo } from 'react';
import type { BlameHunk, FileDiff } from '@shared/types';
import { ZERO_SHA } from '@shared/types';
import { buildDiscardPatch } from '@shared/diff/patch';
import { formatBytes } from '@shared/util';
import * as actions from '../../state/actions';
import { openDialog, useAppStore } from '../../state/store';
import { Avatar, Button, Icon, RelativeTime, Segmented, Spinner, openContextMenu } from '../ui';
import { ExplainPanel } from '../explain/ExplainPanel';
import { FindingCard, SEVERITY_TONE } from '../review/ReviewView';
import { PHONE_QUERY, useMediaQuery } from '../Mobile';
import { ConflictDiff } from './ConflictDiff';
import { ImageDiff } from './ImageDiff';
import { TextDiff, type LineAnnotation } from './TextDiff';

function BlameCard({ hunk }: { hunk: BlameHunk }): React.JSX.Element {
  const isUncommitted = hunk.sha === ZERO_SHA;
  return (
    <div className="blame-card">
      <div className="blame-card-header">
        <Avatar email={hunk.author.email} name={hunk.author.name} size={20} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <strong className="truncate">{isUncommitted ? 'Not committed yet' : hunk.summary || '(no message)'}</strong>
          <span className="muted" style={{ fontSize: 11 }}>
            {hunk.author.name}
            {!isUncommitted ? (
              <>
                {' · '}
                <RelativeTime date={hunk.author.date} />
                {' · '}
                <span className="mono">{hunk.shortSha}</span>
              </>
            ) : null}
          </span>
        </div>
      </div>
      <div className="blame-card-actions">
        <Button size="sm" variant="ghost" onClick={() => actions.openCommitFromBlame(hunk)} disabled={isUncommitted}>Open commit</Button>
        <Button size="sm" variant="ghost" onClick={() => void actions.copyToClipboard(hunk.sha, 'SHA copied')} disabled={isUncommitted}>Copy SHA</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.blameAtParent(hunk)} disabled={isUncommitted || !hunk.previousSha}>Blame at parent</Button>
      </div>
    </div>
  );
}
function PathLabel({ value }: { value: string }): React.JSX.Element {
  const slash = value.lastIndexOf('/');
  const dir = slash === -1 ? '' : value.slice(0, slash + 1);
  const name = slash === -1 ? value : value.slice(slash + 1);
  return (
    <span className="file-path-text" title={value}>
      <span className="file-path-dir">{dir}</span>
      <strong className="file-path-name">{name}</strong>
    </span>
  );
}

export interface DiffPaneProps {
  /** Path shown in the header; null when nothing is selected. */
  path: string | null;
  oldPath?: string | null;
  status?: string | null;
  mode: 'working' | 'commit' | 'stash' | 'review';
  emptyMessage?: string;
}

/** Stable empty selector result: useSyncExternalStore re-renders forever if a selector returns a fresh array each call. */
const NO_PATHS: string[] = [];

/** Memoized: the pane's props are all primitives, so parents re-rendering (keystrokes, toasts, sidebar drags) must not reconcile the diff table. */
export const DiffPane = memo(function DiffPane({ path, oldPath, status, mode, emptyMessage }: DiffPaneProps): React.JSX.Element {
  const diffState = useAppStore((s) => s.diff);
  const settings = useAppStore((s) => s.settings);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isTouch = useMediaQuery('(pointer: coarse)');
  const repo = useAppStore((s) => s.currentRepo);
  const historySha = useAppStore((s) => (mode === 'commit' ? s.history.selectedShas[0] ?? null : null));
  const viewMode = settings?.diffViewMode ?? 'unified';
  const effectiveViewMode = isPhone ? 'unified' : viewMode;
  const hideWhitespace = settings?.diffHideWhitespace ?? false;
  const wrap = settings?.diffWrapLines ?? false;
  const syntax = settings?.diffSyntaxHighlighting ?? true;
  const intraline = settings?.diffShowIntraline ?? true;
  const diff = diffState.diff;
  const selectable = mode === 'working' && !hideWhitespace && !diffState.blameOn && diff?.kind === 'text' && diff.hunks.length > 0;
  // Blame (and file history's "view at commit"/"restore") only apply to text files in the two tabs that show one; not stashes or AI review.
  const blameEligibleMode = mode === 'working' || mode === 'commit';
  const blameDisabled = !diffState.blameOn && (!blameEligibleMode || diff?.kind !== 'text');
  const blameTitle = diffState.blameOn ? 'Hide blame' : !blameEligibleMode ? 'Blame is only available in Changes and History' : diff?.kind !== 'text' ? 'Blame is only available for text files' : 'Show who last changed each line';
  const renderBlameCard = useCallback((hunk: BlameHunk) => <BlameCard hunk={hunk} />, []);
  // Explain: same eligible modes as blame (Changes and History); hidden entirely when the AI provider is disabled.
  const explain = useAppStore((s) => s.explain);
  const aiExplainEnabled = (settings?.ai.provider ?? 'disabled') !== 'disabled';
  const explainEligibleMode = mode === 'working' || mode === 'commit';
  const explainNotActionable = diff !== null && diff.kind !== 'text';
  const explainReason = diff?.kind === 'binary' ? 'binary file' : diff?.kind === 'image' ? 'image file' : diff?.kind === 'submodule' ? 'submodule' : diff?.kind === 'lfs' ? 'Git LFS object' : diff?.kind === 'too-large' ? 'diff too large' : diff?.kind === 'conflict' ? 'unresolved conflict' : null;
  const reviewFindings = useAppStore((s) => (mode === 'review' && s.review.run ? s.review.run.findings : null));
  const activeFindingId = useAppStore((s) => (mode === 'review' ? s.review.activeFindingId : null));
  // Pre-commit review renders its gutter markers/cards in the same "working" diff pane the Changes tab already shows, rather than a separate view.
  const precommitRun = useAppStore((s) => (mode === 'working' ? s.precommitReview.run : null));
  const precommitActiveFindingId = useAppStore((s) => (mode === 'working' ? s.precommitReview.activeFindingId : null));
  const precommitStale = useAppStore((s) => (mode === 'working' ? s.precommitReview.stalePaths : NO_PATHS));
  const findings = reviewFindings ?? precommitRun?.findings ?? null;
  const activeId = mode === 'review' ? activeFindingId : precommitActiveFindingId;
  const annotations = useMemo<LineAnnotation[] | undefined>(() => {
    if (!findings || !path) return undefined;
    const stale = mode === 'working' && precommitStale.includes(path);
    return findings.filter((f) => f.path === path && !f.dismissed).map((f) => ({ id: f.id, line: f.line, tone: stale ? 'neutral' : SEVERITY_TONE[f.severity], title: stale ? `${f.title} (stale — file changed since review)` : f.title }));
  }, [findings, path, mode, precommitStale]);
  const renderAnnotationCard = useCallback(
    (ids: string[]) => (
      <>
        {ids.map((id) => {
          const f = findings?.find((x) => x.id === id);
          if (!f) return null;
          const canApply = mode === 'working' && !!precommitRun && f.suggestion !== null && !precommitRun.target.partialPaths.includes(f.path) && !precommitStale.includes(f.path);
          return <FindingCard key={id} finding={f} onApply={canApply ? () => void actions.applyPrecommitSuggestion(f) : undefined} />;
        })}
      </>
    ),
    [findings, mode, precommitRun, precommitStale],
  );
  const onAnnotationClick = useCallback((id: string) => (mode === 'working' ? actions.setActivePrecommitFinding(precommitActiveFindingId === id ? null : id) : actions.setActiveFinding(activeId === id ? null : id)), [mode, activeId, precommitActiveFindingId]);

  const onSelectionChange = useCallback(
    (selected: Set<string>, total: number) => {
      if (path) actions.setLineSelection(path, selected, total);
    },
    [path],
  );

  const selectedCount = diff?.kind === 'text' ? (diffState.selectedLines === null ? null : diffState.selectedLines.length) : null;
  const total = diff?.kind === 'text' ? diff.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type !== 'context').length, 0) : 0;

  const discardSelected = () => {
    if (!diff || diff.kind !== 'text' || !path) return;
    const set = diffState.selectedLines === null ? null : new Set(diffState.selectedLines);
    const patch = buildDiscardPatch({ oldPath: diff.oldPath, newPath: diff.newPath, hunks: diff.hunks }, (h, l) => (set === null ? true : set.has(`${h}:${l}`)));
    if (!patch) return;
    const count = set === null ? total : set.size;
    if (settings?.confirmDiscardChanges === false) void actions.discardPatch(patch);
    else openDialog({ kind: 'discard-lines', path, patch, count });
  };

  if (!path) {
    return (
      <div className="diff-pane">
        <div className="empty-state">
          <Icon name="diff-modified" size={32} />
          <p>{emptyMessage ?? 'Select a file to view its changes.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-pane">
      <div className="diff-header">
        <span className="file-path">
          <span className="file-path-main">
          {oldPath && oldPath !== path ? (
            <>
              <span className="muted file-path-old"><PathLabel value={oldPath} /></span>
              <Icon name="chevron-right" size={12} className="arrow" />
            </>
          ) : null}
          <PathLabel value={path} />
          </span>
          <span className="file-meta">
          {status ? <span className={`badge ${status === 'new' || status === 'untracked' ? 'success' : status === 'deleted' || status === 'conflicted' ? 'danger' : status === 'modified' ? 'attention' : 'accent'}`}>{status === 'untracked' ? 'new' : status}</span> : null}
          {diff?.kind === 'text' ? (
            <span className="muted" style={{ fontFamily: 'var(--font-ui)', fontSize: 11 }}>
              {(() => {
                let a = 0;
                let d = 0;
                for (const h of diff.hunks) for (const l of h.lines) l.type === 'add' ? a++ : l.type === 'delete' ? d++ : 0;
                return (
                  <>
                    <span className="stat-add">+{a}</span> <span className="stat-del">−{d}</span>
                  </>
                );
              })()}
            </span>
          ) : null}
          </span>
        </span>
        <span className="controls">
          {diff?.kind === 'text' ? (
            <>
              <Segmented
                value={viewMode}
                onChange={(v) => void actions.updateSettings({ diffViewMode: v })}
                options={[
                  { value: 'unified', label: <span aria-label="Unified diff view"><Icon name="rows" size={14} /></span>, title: 'Unified view' },
                  { value: 'split', label: <span aria-label="Split diff view"><Icon name="columns" size={14} /></span>, title: 'Split view' },
                ]}
              />
              <Button variant={hideWhitespace ? 'accent' : 'ghost'} size="sm" iconOnly icon="eye" aria-label={hideWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'} title={hideWhitespace ? 'Showing diff without whitespace changes (line selection disabled)' : 'Hide whitespace changes'} onClick={() => void actions.updateSettings({ diffHideWhitespace: !hideWhitespace })} />
              <Button variant={wrap ? 'accent' : 'ghost'} size="sm" iconOnly icon="wrap" aria-label={wrap ? 'Disable line wrapping' : 'Enable line wrapping'} title={wrap ? 'Disable line wrapping' : 'Wrap long lines'} onClick={() => void actions.updateSettings({ diffWrapLines: !wrap })} />
            </>
          ) : null}
          {blameEligibleMode ? <Button variant={diffState.blameOn ? 'accent' : 'ghost'} size="sm" iconOnly icon="person" aria-label={diffState.blameOn ? 'Hide blame' : 'Toggle blame'} loading={diffState.blameOn && diffState.blameLoading} title={blameTitle} disabled={blameDisabled} onClick={() => actions.toggleBlame()} /> : null}
          {explainEligibleMode && aiExplainEnabled ? (
            <Button
              variant={explain.open ? 'accent' : 'ghost'}
              size="sm"
              iconOnly
              icon="sparkle"
              aria-label="Explain with AI"
              title={explainNotActionable ? `Nothing to explain (${explainReason ?? 'not a text diff'})` : 'Explain this file'}
              disabled={explainNotActionable}
              onClick={() => actions.explainCurrentFile()}
            />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="kebab"
            aria-label="More diff options"
            title="More"
            onClick={(e) =>
              openContextMenu(e, [
                { label: 'Open in external editor', onClick: () => void actions.openInEditor(status === 'deleted' ? null : path) },
                { label: 'Show in folder', onClick: () => void actions.showInFolder(status === 'deleted' ? null : path) },
                { label: 'Copy relative path', onClick: () => void actions.copyToClipboard(path, 'Path copied') },
                { type: 'separator' },
                { label: syntax ? 'Disable syntax highlighting' : 'Enable syntax highlighting', onClick: () => void actions.updateSettings({ diffSyntaxHighlighting: !syntax }) },
                { label: intraline ? 'Hide word-level changes' : 'Show word-level changes', onClick: () => void actions.updateSettings({ diffShowIntraline: !intraline }) },
                { label: 'Increase font size', onClick: () => void actions.updateSettings({ diffFontSize: Math.min(24, (settings?.diffFontSize ?? 12) + 1) }) },
                { label: 'Decrease font size', onClick: () => void actions.updateSettings({ diffFontSize: Math.max(9, (settings?.diffFontSize ?? 12) - 1) }) },
                { type: 'separator' as const },
                { label: 'Search history for selection', onClick: () => actions.searchHistoryForSelection(window.getSelection()?.toString() ?? ''), disabled: !window.getSelection()?.toString().trim() },
                ...(blameEligibleMode ? [{ type: 'separator' as const }, { label: 'File history…', onClick: () => actions.openFileHistory(path) }] : []),
                ...(mode === 'commit' && historySha ? [
                  { label: 'View file at this commit', onClick: () => actions.openFileAtCommit(path, historySha), disabled: diff?.kind !== 'text' && diff?.kind !== 'binary' },
                  { label: 'Restore this version…', onClick: () => actions.requestRestoreFile(path, historySha) },
                ] : []),
                ...(repo?.github && mode !== 'stash' ? [{ type: 'separator' as const }, { label: 'View file on GitHub', onClick: () => void actions.openExternal(`${repo.github!.url}/blob/HEAD/${path}`) }] : []),
              ])
            }
          />
        </span>
      </div>
      {selectable && selectedCount !== null && selectedCount !== total ? (
        <div className="diff-selection-bar">
          <Icon name="check" size={12} />
          <span className="selection-copy">
            {selectedCount} of {total} changed line{total === 1 ? '' : 's'} will be committed
          </span>
          <span className="selection-spacer" style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={() => onSelectionChange(new Set(diff.hunks.flatMap((h, hi) => h.lines.map((l, li) => (l.type !== 'context' ? `${hi}:${li}` : '')).filter(Boolean))), total)}>Select all</Button>
          {selectedCount > 0 ? <Button size="sm" variant="danger" icon="trash" onClick={discardSelected}>Discard {selectedCount} selected line{selectedCount === 1 ? '' : 's'}…</Button> : null}
        </div>
      ) : selectable && total > 0 && mode === 'working' ? (
        <div className="diff-selection-bar" style={{ background: 'var(--bg-subtle)' }}>
          <span className="muted selection-copy">{isTouch ? 'Tap check column to choose lines; drag for a range.' : 'Click check column to choose lines; drag for a range.'}</span>
          <span className="selection-spacer" style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" icon="trash" onClick={discardSelected}>Discard all lines…</Button>
        </div>
      ) : null}
      {diffState.blameOn && diffState.blame?.shallow ? (
        <div className="diff-selection-bar" style={{ background: 'var(--attention-subtle)' }}>
          <Icon name="alert" size={12} />
          <span>History truncated (shallow clone): attribution may stop before the file's true origin.</span>
        </div>
      ) : null}
      <div className="diff-body-row">
        <div className={`diff-body ${diffState.loading && !diff ? 'loading' : ''}`}>
          {diffState.loading && !diff ? <Spinner large /> : null}
          {diffState.error ? (
            <div className="diff-message">
              <Icon name="alert" size={24} />
              <strong>Could not load the diff</strong>
              <span>{diffState.error}</span>
            </div>
          ) : null}
          {diff ? (
            <DiffBody
              diff={diff}
              path={path}
              mode={mode}
              viewMode={effectiveViewMode}
              wrap={wrap}
              syntax={syntax}
              intraline={intraline}
              selectable={selectable}
              selectedLines={diffState.selectedLines}
              onSelectionChange={onSelectionChange}
              annotations={annotations}
              activeAnnotationId={activeId}
              onAnnotationClick={onAnnotationClick}
              renderAnnotationCard={renderAnnotationCard}
              blame={diffState.blameOn ? diffState.blame?.hunks ?? [] : null}
              activeBlameId={diffState.activeBlameId}
              onBlameBlockClick={actions.setActiveBlame}
              renderBlameCard={renderBlameCard}
              highlightTerm={mode === 'commit' ? diffState.highlightTerm : null}
              onExplainRange={explainEligibleMode && aiExplainEnabled ? (hunkIndex, startLine, endLine) => actions.explainSelectedLines(path, hunkIndex, startLine, endLine) : undefined}
            />
          ) : null}
        </div>
        {explain.open ? <ExplainPanel /> : null}
      </div>
    </div>
  );
});

function DiffBody({ diff, path, viewMode, wrap, syntax, intraline, selectable, selectedLines, onSelectionChange, annotations, activeAnnotationId, onAnnotationClick, renderAnnotationCard, blame, activeBlameId, onBlameBlockClick, renderBlameCard, highlightTerm, onExplainRange }: { diff: FileDiff; path: string; mode: string; viewMode: 'unified' | 'split'; wrap: boolean; syntax: boolean; intraline: boolean; selectable: boolean; selectedLines: string[] | null; onSelectionChange: (s: Set<string>, total: number) => void; annotations?: LineAnnotation[]; activeAnnotationId?: string | null; onAnnotationClick?: (id: string) => void; renderAnnotationCard?: (ids: string[]) => React.ReactNode; blame?: BlameHunk[] | null; activeBlameId?: string | null; onBlameBlockClick?: (id: string) => void; renderBlameCard?: (hunk: BlameHunk) => React.ReactNode; highlightTerm?: { text: string; regex: boolean } | null; onExplainRange?: (hunkIndex: number, startLine: number, endLine: number) => void }): React.JSX.Element {
  switch (diff.kind) {
    case 'text':
      return <TextDiff diff={diff} mode={viewMode} wrap={wrap} syntax={syntax} intraline={intraline} selectable={selectable} selectedLines={selectedLines} onSelectionChange={onSelectionChange} annotations={annotations} activeAnnotationId={activeAnnotationId} onAnnotationClick={onAnnotationClick} renderAnnotationCard={renderAnnotationCard} blame={blame} activeBlameId={activeBlameId} onBlameBlockClick={onBlameBlockClick} renderBlameCard={renderBlameCard} highlightTerm={highlightTerm} onExplainRange={onExplainRange} />;
    case 'conflict':
      return <ConflictDiff diff={diff} path={path} syntax={syntax} />;
    case 'image':
      return <ImageDiff diff={diff} />;
    case 'binary':
      return (
        <div className="diff-message">
          <Icon name="file" size={24} />
          <strong>Binary file not shown</strong>
          <span>
            {diff.oldBytes !== null ? `${formatBytes(diff.oldBytes)} → ` : ''}
            {diff.newBytes !== null ? formatBytes(diff.newBytes) : 'deleted'}
          </span>
          <Button size="sm" onClick={() => void actions.openInEditor(path)}>Open in external editor</Button>
        </div>
      );
    case 'submodule':
      return (
        <div className="diff-message" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>Submodule changes</strong>
          <span className="mono">
            {diff.oldSha?.slice(0, 7) ?? '—'} → {diff.newSha?.slice(0, 7) ?? '—'}
          </span>
          <pre className="details-block" style={{ width: '100%' }}>{diff.summary}</pre>
          <span className="banner-actions">
            <Button size="sm" onClick={() => void actions.updateSubmoduleToRecorded(path)}>Update to recorded commit</Button>
            <Button size="sm" onClick={() => void actions.openSubmoduleAsRepository(path)}>Open submodule</Button>
          </span>
        </div>
      );
    case 'lfs':
      return diff.inner ? (
        <ImageDiff diff={diff.inner as Extract<FileDiff, { kind: 'image' }>} />
      ) : (
        <div className="diff-message">
          <Icon name="download" size={24} />
          <strong>Git LFS object</strong>
          <span className="mono">
            {diff.oldOid?.slice(0, 10) ?? '—'} → {diff.newOid?.slice(0, 10) ?? '—'}
          </span>
          <span>{formatBytes(diff.size)}</span>
          {diff.present ? null : <Button size="sm" icon="download" onClick={() => void actions.downloadLfsObject(path)}>Download</Button>}
        </div>
      );
    case 'too-large':
      return (
        <div className="diff-message">
          <Icon name="alert" size={24} />
          <strong>This diff is too large to display</strong>
          <span>{diff.lineCount ? `${diff.lineCount.toLocaleString()} lines` : formatBytes(diff.bytes)}. Open the file in your editor to review it.</span>
          <Button size="sm" onClick={() => void actions.openInEditor(path)}>Open in external editor</Button>
        </div>
      );
    case 'empty':
      return (
        <div className="diff-message">
          <Icon name="info" size={24} />
          <span>{diff.reason}</span>
        </div>
      );
  }
}
