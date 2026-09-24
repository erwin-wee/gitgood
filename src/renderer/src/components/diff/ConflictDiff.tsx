import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConflictBlockResolution, FileDiff } from '@shared/types';
import { applyResolutions, parseConflicts, resolutionForChoice, type BlockChoice } from '@shared/diff/conflicts';
import { escapeHtml } from '@shared/util';
import { highlightBlockLine } from '../../lib/highlight';
import { useWindowedRows } from '../../lib/windowing';
import * as actions from '../../state/actions';
import { openDialog, useAppStore } from '../../state/store';
import { Button, Icon, Spinner } from '../ui';

type ConflictData = Extract<FileDiff, { kind: 'conflict' }>;

/** Per-line confidence tint, computed once a file has been AI-resolved (no markers left) and its blocks/ranges are known. */
interface LineTint {
  blockId: number;
  confidence: ConflictBlockResolution['confidence'];
  isStart: boolean;
}

const CONFLICT_ROW_ESTIMATES = { line: 20, actions: 48 };

export function ConflictDiff({ diff, path, syntax }: { diff: ConflictData; path: string; syntax: boolean }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const aiState = useAppStore((s) => s.ai[path]);
  const operation = useAppStore((s) => s.status?.operation.kind ?? 'none');
  const resolution = useAppStore((s) => s.conflictResolutions[path]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const [lowIndex, setLowIndex] = useState(0);
  const parsed = useMemo(() => parseConflicts(diff.content), [diff.content]);
  // The toolbar sits above the lines inside the scroller; its ~40px offset is well within the window's overscan.
  useLayoutEffect(() => setScrollContainer(containerRef.current?.closest<HTMLElement>('.diff-body') ?? null), []);
  const hlCache = useRef(new Map<string, string[] | null>());
  useMemo(() => hlCache.current.clear(), [syntax, parsed.lines, diff.language]);
  const blocksByMarkerLine = useMemo(() => {
    const map = new Map<number, (typeof parsed.blocks)[number]>();
    for (const block of parsed.blocks) map.set(block.end - 1, block);
    return map;
  }, [parsed.blocks]);
  const blocksById = useMemo(() => {
    const map = new Map<number, (typeof parsed.blocks)[number]>();
    for (const block of parsed.blocks) map.set(block.id, block);
    return map;
  }, [parsed.blocks]);
  const win = useWindowedRows(scrollContainer, {
    count: parsed.lines.length,
    kindOf: (i) => (blocksByMarkerLine.has(i) ? 'actions' : 'line'),
    estimates: CONFLICT_ROW_ESTIMATES,
    resetKey: diff.content,
  });

  const highlighted = useCallback(
    (lineNo: number): string | undefined => (syntax ? highlightBlockLine(hlCache.current, 'file', parsed.lines, lineNo, diff.language) : undefined),
    [syntax, parsed.lines, diff.language],
  );

  const lineKinds = useMemo(() => {
    const kinds: ('plain' | 'marker' | 'ours' | 'base' | 'theirs')[] = new Array(parsed.lines.length).fill('plain');
    for (const b of parsed.blocks) {
      let section: 'ours' | 'base' | 'theirs' = 'ours';
      kinds[b.start] = 'marker';
      for (let i = b.start + 1; i < b.end - 1; i++) {
        const l = parsed.lines[i];
        if (/^\|{7,}/.test(l) && section === 'ours') {
          section = 'base';
          kinds[i] = 'marker';
          continue;
        }
        if (/^={7,}$/.test(l) && section !== 'theirs') {
          section = 'theirs';
          kinds[i] = 'marker';
          continue;
        }
        kinds[i] = section;
      }
      kinds[b.end - 1] = 'marker';
    }
    return kinds;
  }, [parsed]);

  // Tints only make sense once the markers are gone (the AI wrote its resolution and, unless
  // auto-stage is off or a check failed, the file may still show as "conflicted" in git's index).
  const tintsByLine = useMemo(() => {
    if (!resolution || parsed.blocks.length > 0) return null;
    const map = new Map<number, LineTint>();
    for (const b of resolution.blocks) {
      for (let i = b.range.start; i < b.range.end && i < parsed.lines.length; i++) {
        map.set(i, { blockId: b.id, confidence: b.confidence, isStart: i === b.range.start });
      }
    }
    return map;
  }, [resolution, parsed]);

  const lowConfidenceLines = useMemo(() => {
    if (!tintsByLine) return [];
    return [...tintsByLine.entries()].filter(([, t]) => t.confidence === 'low' && t.isStart).map(([line]) => line);
  }, [tintsByLine]);

  const jumpToLine = (line: number) => {
    win.scrollTo(line, 'center');
  };

  const jumpLow = (delta: 1 | -1) => {
    if (!lowConfidenceLines.length) return;
    const next = (lowIndex + delta + lowConfidenceLines.length) % lowConfidenceLines.length;
    setLowIndex(next);
    jumpToLine(lowConfidenceLines[next]);
  };

  const choose = (blockId: number, choice: BlockChoice) => {
    const block = blocksById.get(blockId);
    if (!block) return;
    const { content } = applyResolutions(parsed, new Map([[blockId, resolutionForChoice(block, choice)]]));
    void actions.writeResolvedContent(path, content, parsed.blocks.length > 1, diff.content);
  };

  const oursName = operation === 'rebase' ? `${diff.oursLabel} (upstream)` : `${diff.oursLabel} (current branch)`;
  const theirsName = operation === 'rebase' ? `${diff.theirsLabel} (your commit)` : `${diff.theirsLabel} (incoming)`;
  const aiEnabled = settings?.ai.provider !== 'disabled';

  const counts = resolution ? { high: resolution.blocks.filter((b) => b.confidence === 'high').length, medium: resolution.blocks.filter((b) => b.confidence === 'medium').length, low: resolution.blocks.filter((b) => b.confidence === 'low').length } : null;

  return (
    <div className="conflict-view">
      <div className="conflict-toolbar">
        <Icon name="alert" />
        <strong>
          {parsed.blocks.length} conflict{parsed.blocks.length === 1 ? '' : 's'} in this file
        </strong>
        {aiState && aiState.phase !== 'done' && aiState.phase !== 'error' ? (
          <span className="ai-status">
            <Spinner /> {aiState.message}
          </span>
        ) : null}
        {resolution?.guidedBy.length ? (
          <span className="badge accent" title={`Guided by the manual resolution of ${resolution.guidedBy.join(', ')}`}>
            Guided by {resolution.guidedBy[0]}
            {resolution.guidedBy.length > 1 ? ` +${resolution.guidedBy.length - 1}` : ''}
          </span>
        ) : null}
        {resolution?.check ? (
          <span className={`badge ${resolution.check.ok ? 'success' : 'danger'}`} title={resolution.check.command}>
            {resolution.check.ok ? 'Check passed' : resolution.check.timedOut ? 'Check timed out' : 'Check failed'}
          </span>
        ) : null}
        <span className="spacer" />
        {counts && counts.high + counts.medium + counts.low > 0 ? (
          <div className="conflict-legend">
            <span className="legend-chip conf-high" title="High confidence">{counts.high} high</span>
            <span className="legend-chip conf-medium" title="Medium confidence">{counts.medium} medium</span>
            <span className="legend-chip conf-low" title="Low confidence">{counts.low} low</span>
            {lowConfidenceLines.length > 1 ? (
              <>
                <Button size="sm" variant="ghost" iconOnly icon="arrow-up" title="Previous low-confidence block" onClick={() => jumpLow(-1)} />
                <Button size="sm" variant="ghost" iconOnly icon="arrow-down" title="Next low-confidence block" onClick={() => jumpLow(1)} />
              </>
            ) : null}
          </div>
        ) : null}
        {aiEnabled ? (
          <Button variant="accent" size="sm" icon="sparkle" loading={aiBusy} onClick={() => void actions.resolveWithAi(path)} title="Let Claude reconcile both sides of every conflict block">
            Resolve with AI
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void actions.useSide(path, 'ours')} title={`Take the whole file from ${oursName}`}>Use ours</Button>
        <Button size="sm" onClick={() => void actions.useSide(path, 'theirs')} title={`Take the whole file from ${theirsName}`}>Use theirs</Button>
        <Button size="sm" icon="pencil" onClick={() => void actions.openInEditor(path)}>Open in editor</Button>
        {parsed.blocks.length === 0 ? (
          <Button size="sm" variant="primary" icon="check" onClick={() => void actions.markResolved([path])}>Mark as resolved</Button>
        ) : null}
      </div>
      <div ref={containerRef}>
        {win.top > 0 ? <div aria-hidden style={{ height: win.top }} /> : null}
        {Array.from({ length: win.end - win.start }, (_, offset) => {
          const i = win.start + offset;
          const line = parsed.lines[i];
          const kind = lineKinds[i];
          const block = kind === 'marker' ? blocksByMarkerLine.get(i) : undefined;
          const tint = tintsByLine?.get(i);
          return (
            <div ref={win.rowRef(i)} key={i}>
              <div className={`conflict-line ${kind}${tint ? ` conf-${tint.confidence}` : ''}`} data-conflict-line={i}>
                <span className="num">
                  {tint?.isStart ? (
                    <button
                      type="button"
                      className="conf-badge"
                      title={`${tint.confidence} confidence — click for the model's rationale and per-block actions`}
                      onClick={() => openDialog({ kind: 'resolution-popover', path, blockId: tint.blockId })}
                    >
                      <Icon name="sparkle" size={10} />
                    </button>
                  ) : null}
                  {i + 1}
                </span>
                <span className="code" dangerouslySetInnerHTML={{ __html: (kind === 'plain' ? highlighted(i + 1) ?? escapeHtml(line) : escapeHtml(line)) || ' ' }} />
              </div>
              {block ? (
                <div className="conflict-block-actions">
                  <span className="label">Accept:</span>
                  <Button size="sm" onClick={() => choose(block.id, 'ours')} title={oursName}>Ours</Button>
                  <Button size="sm" onClick={() => choose(block.id, 'theirs')} title={theirsName}>Theirs</Button>
                  <Button size="sm" onClick={() => choose(block.id, 'both')} title="Ours followed by theirs">Both</Button>
                  <Button size="sm" onClick={() => choose(block.id, 'both-reversed')} title="Theirs followed by ours">Both (theirs first)</Button>
                  {block.base ? <Button size="sm" onClick={() => choose(block.id, 'base')} title="Restore the common ancestor version">Base</Button> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {win.bottom > 0 ? <div aria-hidden style={{ height: win.bottom }} /> : null}
      </div>
    </div>
  );
}
