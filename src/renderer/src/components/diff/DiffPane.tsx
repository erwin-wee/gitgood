import React, { useCallback } from 'react';
import type { FileDiff } from '@shared/types';
import { buildDiscardPatch } from '@shared/diff/patch';
import { formatBytes } from '@shared/util';
import * as actions from '../../state/actions';
import { openDialog, useAppStore } from '../../state/store';
import { Button, Icon, Segmented, Spinner, openContextMenu } from '../ui';
import { ConflictDiff } from './ConflictDiff';
import { ImageDiff } from './ImageDiff';
import { TextDiff } from './TextDiff';

export interface DiffPaneProps {
  /** Path shown in the header; null when nothing is selected. */
  path: string | null;
  oldPath?: string | null;
  status?: string | null;
  mode: 'working' | 'commit' | 'stash';
  emptyMessage?: string;
}

export function DiffPane({ path, oldPath, status, mode, emptyMessage }: DiffPaneProps): React.JSX.Element {
  const diffState = useAppStore((s) => s.diff);
  const settings = useAppStore((s) => s.settings);
  const repo = useAppStore((s) => s.currentRepo);
  const viewMode = settings?.diffViewMode ?? 'unified';
  const hideWhitespace = settings?.diffHideWhitespace ?? false;
  const wrap = settings?.diffWrapLines ?? false;
  const syntax = settings?.diffSyntaxHighlighting ?? true;
  const intraline = settings?.diffShowIntraline ?? true;
  const diff = diffState.diff;
  const selectable = mode === 'working' && !hideWhitespace && diff?.kind === 'text' && diff.hunks.length > 0;

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
          {oldPath && oldPath !== path ? (
            <>
              <span className="muted">{oldPath}</span>
              <Icon name="chevron-right" size={12} className="arrow" />
            </>
          ) : null}
          <span>{path}</span>
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
        <span className="controls">
          {diff?.kind === 'text' ? (
            <>
              <Segmented
                value={viewMode}
                onChange={(v) => void actions.updateSettings({ diffViewMode: v })}
                options={[
                  { value: 'unified', label: <Icon name="rows" size={14} />, title: 'Unified view' },
                  { value: 'split', label: <Icon name="columns" size={14} />, title: 'Split view' },
                ]}
              />
              <Button variant={hideWhitespace ? 'accent' : 'ghost'} size="sm" iconOnly icon="eye" title={hideWhitespace ? 'Showing diff without whitespace changes (line selection disabled)' : 'Hide whitespace changes'} onClick={() => void actions.updateSettings({ diffHideWhitespace: !hideWhitespace })} />
              <Button variant={wrap ? 'accent' : 'ghost'} size="sm" iconOnly icon="wrap" title={wrap ? 'Disable line wrapping' : 'Wrap long lines'} onClick={() => void actions.updateSettings({ diffWrapLines: !wrap })} />
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="kebab"
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
                ...(repo?.github && mode !== 'stash' ? [{ type: 'separator' as const }, { label: 'View file on GitHub', onClick: () => void actions.openExternal(`${repo.github!.url}/blob/HEAD/${path}`) }] : []),
              ])
            }
          />
        </span>
      </div>
      {selectable && selectedCount !== null && selectedCount !== total ? (
        <div className="diff-selection-bar">
          <Icon name="check" size={12} />
          <span>
            {selectedCount} of {total} changed line{total === 1 ? '' : 's'} will be committed
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={() => onSelectionChange(new Set(diff.hunks.flatMap((h, hi) => h.lines.map((l, li) => (l.type !== 'context' ? `${hi}:${li}` : '')).filter(Boolean))), total)}>Select all</Button>
          {selectedCount > 0 ? <Button size="sm" variant="danger" icon="trash" onClick={discardSelected}>Discard {selectedCount} selected line{selectedCount === 1 ? '' : 's'}…</Button> : null}
        </div>
      ) : selectable && total > 0 && mode === 'working' ? (
        <div className="diff-selection-bar" style={{ background: 'var(--bg-subtle)' }}>
          <span className="muted">Click the check column to choose which lines to commit; drag to select a range.</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" icon="trash" onClick={discardSelected}>Discard all lines…</Button>
        </div>
      ) : null}
      <div className={`diff-body ${diffState.loading && !diff ? 'loading' : ''}`}>
        {diffState.loading && !diff ? <Spinner large /> : null}
        {diffState.error ? (
          <div className="diff-message">
            <Icon name="alert" size={24} />
            <strong>Could not load the diff</strong>
            <span>{diffState.error}</span>
          </div>
        ) : null}
        {diff ? <DiffBody diff={diff} path={path} mode={mode} viewMode={viewMode} wrap={wrap} syntax={syntax} intraline={intraline} selectable={selectable} selectedLines={diffState.selectedLines} onSelectionChange={onSelectionChange} /> : null}
      </div>
    </div>
  );
}

function DiffBody({ diff, path, viewMode, wrap, syntax, intraline, selectable, selectedLines, onSelectionChange }: { diff: FileDiff; path: string; mode: string; viewMode: 'unified' | 'split'; wrap: boolean; syntax: boolean; intraline: boolean; selectable: boolean; selectedLines: string[] | null; onSelectionChange: (s: Set<string>, total: number) => void }): React.JSX.Element {
  switch (diff.kind) {
    case 'text':
      return <TextDiff diff={diff} mode={viewMode} wrap={wrap} syntax={syntax} intraline={intraline} selectable={selectable} selectedLines={selectedLines} onSelectionChange={onSelectionChange} />;
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
