import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BlameHunk, DiffHunk, DiffLine, FileDiff } from '@shared/types';
import { ZERO_SHA } from '@shared/types';
import { intralineDiff, type CharRange } from '@shared/diff/intraline';
import { escapeHtml } from '@shared/util';
import { highlightToLines } from '../../lib/highlight';
import { Icon, openContextMenu } from '../ui';

type TextDiffData = Extract<FileDiff, { kind: 'text' }>;

/** A marker attached to a new-side line (used by AI review findings). */
export interface LineAnnotation {
  id: string;
  /** New-side line number. */
  line: number;
  tone: 'danger' | 'attention' | 'neutral';
  title: string;
}

/** Stable id for one blame block instance (a commit can have several runs, so sha alone isn't unique). */
export function blameBlockId(hunk: BlameHunk): string {
  return `${hunk.sha}:${hunk.startLine}`;
}

export interface TextDiffProps {
  diff: TextDiffData;
  mode: 'unified' | 'split';
  wrap: boolean;
  syntax: boolean;
  intraline: boolean;
  /** When set, add/delete lines can be toggled for partial commits. */
  selectable: boolean;
  selectedLines: string[] | null;
  onSelectionChange?: (selected: Set<string>, total: number) => void;
  /** Gutter markers keyed by new-side line; clicking one toggles it active. */
  annotations?: LineAnnotation[];
  activeAnnotationId?: string | null;
  onAnnotationClick?: (id: string) => void;
  /** Renders the inline card shown under a line whose annotation is active. */
  renderAnnotationCard?: (ids: string[]) => React.ReactNode;
  /** Blame gutter, keyed by new-side line number (the file's own line numbers, since blame targets a full file view). */
  blame?: BlameHunk[] | null;
  activeBlameId?: string | null;
  onBlameBlockClick?: (id: string) => void;
  renderBlameCard?: (hunk: BlameHunk) => React.ReactNode;
  /** Set when a History content/regex search is active: scrolls to and highlights the first add/delete line whose text matches. */
  highlightTerm?: { text: string; regex: boolean } | null;
  /** When set, right-clicking a line (or a text selection spanning several lines of one hunk) offers "Explain selected lines"/"Explain this line", reporting the new-side line range. */
  onExplainRange?: (hunkIndex: number, startLine: number, endLine: number) => void;
}

const EXPAND_STEP = 20;

/** Applies character ranges as <span class=cls> marks onto highlighted HTML, keeping tags balanced. */
export function markHtml(html: string, ranges: CharRange[], cls: string): string {
  if (!ranges.length) return html;
  let out = '';
  let textPos = 0;
  let rangeIdx = 0;
  let inMark = false;
  let i = 0;
  const open = `<span class="${cls}">`;
  const close = '</span>';
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const emitChar = (chunk: string) => {
    while (rangeIdx < sorted.length && textPos >= sorted[rangeIdx].end) {
      if (inMark) {
        out += close;
        inMark = false;
      }
      rangeIdx++;
    }
    const r = sorted[rangeIdx];
    const shouldMark = !!r && textPos >= r.start && textPos < r.end;
    if (shouldMark && !inMark) {
      out += open;
      inMark = true;
    } else if (!shouldMark && inMark) {
      out += close;
      inMark = false;
    }
    out += chunk;
    textPos++;
  };
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) break;
      const tag = html.slice(i, end + 1);
      if (inMark) out += close;
      out += tag;
      if (inMark) out += open;
      i = end + 1;
      continue;
    }
    if (ch === '&') {
      const end = html.indexOf(';', i);
      if (end !== -1 && end - i <= 8) {
        emitChar(html.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    emitChar(ch);
    i++;
  }
  if (inMark) out += close;
  return out;
}

interface ExtraLine {
  text: string;
  oldNo: number;
  newNo: number;
}

interface HunkView {
  hunkIndex: number;
  hunk: DiffHunk;
  above: ExtraLine[];
  below: ExtraLine[];
  canExpandUp: number;
  canExpandDown: number;
  /** Lines in the gap after this hunk (before the next), shown only for the last hunk's bottom. */
}

function splitContent(content: string | null): string[] | null {
  if (content === null) return null;
  const lines = content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '' && content.endsWith('\n')) lines.pop();
  return lines;
}

function buildViews(hunks: DiffHunk[], newLines: string[] | null, expansions: Record<string, number>): HunkView[] {
  const views: HunkView[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const prev = hunks[i - 1];
    const next = hunks[i + 1];
    const endNew = h.newStart + Math.max(h.newLines, 1) - 1;
    const endOld = h.oldStart + Math.max(h.oldLines, 1) - 1;
    const gapAboveStart = prev ? prev.newStart + Math.max(prev.newLines, 1) : 1;
    const gapAboveSize = Math.max(0, h.newStart - gapAboveStart);
    const gapBelowEnd = next ? next.newStart - 1 : newLines ? newLines.length : endNew;
    const gapBelowSize = Math.max(0, gapBelowEnd - endNew);
    const prevDown = prev ? expansions[`${i - 1}:down`] ?? 0 : 0;
    const up = Math.min(expansions[`${i}:up`] ?? 0, Math.max(0, gapAboveSize - prevDown));
    const nextUp = next ? expansions[`${i + 1}:up`] ?? 0 : 0;
    const down = Math.min(expansions[`${i}:down`] ?? 0, Math.max(0, gapBelowSize - nextUp));
    const above: ExtraLine[] = [];
    const below: ExtraLine[] = [];
    if (newLines) {
      for (let k = up; k >= 1; k--) {
        const newNo = h.newStart - k;
        if (newNo < 1 || newNo > newLines.length) continue;
        above.push({ text: newLines[newNo - 1], oldNo: h.oldStart - k, newNo });
      }
      for (let k = 1; k <= down; k++) {
        const newNo = endNew + k;
        if (newNo > newLines.length) break;
        below.push({ text: newLines[newNo - 1], oldNo: endOld + k, newNo });
      }
    }
    views.push({ hunkIndex: i, hunk: h, above, below, canExpandUp: newLines ? Math.max(0, gapAboveSize - prevDown - up) : 0, canExpandDown: newLines ? Math.max(0, gapBelowSize - nextUp - down) : 0 });
  }
  return views;
}

interface Pair {
  left: { line: DiffLine; key: string; index: number } | null;
  right: { line: DiffLine; key: string; index: number } | null;
}

function pairLines(hunk: DiffHunk, hunkIndex: number): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  const lines = hunk.lines;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'context') {
      pairs.push({ left: { line: l, key: `${hunkIndex}:${i}`, index: i }, right: { line: l, key: `${hunkIndex}:${i}`, index: i } });
      i++;
      continue;
    }
    const dels: { line: DiffLine; key: string; index: number }[] = [];
    const adds: { line: DiffLine; key: string; index: number }[] = [];
    while (i < lines.length && lines[i].type === 'delete') {
      dels.push({ line: lines[i], key: `${hunkIndex}:${i}`, index: i });
      i++;
    }
    while (i < lines.length && lines[i].type === 'add') {
      adds.push({ line: lines[i], key: `${hunkIndex}:${i}`, index: i });
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    if (dels.length === 0 && adds.length === 0) i++;
  }
  return pairs;
}

export function TextDiff({ diff, mode, wrap, syntax, intraline, selectable, selectedLines, onSelectionChange, annotations, activeAnnotationId, onAnnotationClick, renderAnnotationCard, blame, activeBlameId, onBlameBlockClick, renderBlameCard, highlightTerm, onExplainRange }: TextDiffProps): React.JSX.Element {
  const [expansions, setExpansions] = useState<Record<string, number>>({});
  useEffect(() => setExpansions({}), [diff]);
  const tableRef = useRef<HTMLTableElement>(null);

  const annotationsByLine = useMemo(() => {
    const map = new Map<number, LineAnnotation[]>();
    for (const a of annotations ?? []) {
      const list = map.get(a.line) ?? [];
      list.push(a);
      map.set(a.line, list);
    }
    return map;
  }, [annotations]);
  const activeLine = useMemo(() => (activeAnnotationId ? annotations?.find((a) => a.id === activeAnnotationId)?.line ?? null : null), [annotations, activeAnnotationId]);
  useEffect(() => {
    if (activeLine === null || !tableRef.current) return;
    const row = tableRef.current.querySelector<HTMLElement>(`tr[data-new-line="${activeLine}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [activeLine, diff]);

  // First add/delete/context line (in diff order) whose text matches the active History content/regex search.
  const highlightKey = useMemo(() => {
    if (!highlightTerm?.text) return null;
    let re: RegExp | null = null;
    if (highlightTerm.regex) {
      try {
        re = new RegExp(highlightTerm.text);
      } catch {
        return null;
      }
    }
    for (let hi = 0; hi < diff.hunks.length; hi++) {
      const lines = diff.hunks[hi].lines;
      for (let li = 0; li < lines.length; li++) {
        const l = lines[li];
        if (l.type === 'context') continue;
        const matched = re ? re.test(l.text) : l.text.includes(highlightTerm.text);
        if (matched) return `${hi}:${li}`;
      }
    }
    return null;
  }, [diff.hunks, highlightTerm]);
  useEffect(() => {
    if (!highlightKey || !tableRef.current) return;
    const row = tableRef.current.querySelector<HTMLElement>(`tr[data-key="${highlightKey}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [highlightKey, diff]);

  const TONE_RANK = { danger: 0, attention: 1, neutral: 2 } as const;
  const annotationMarker = (newNo: number | null) => {
    if (newNo === null) return null;
    const list = annotationsByLine.get(newNo);
    if (!list?.length) return null;
    const tone = [...list].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])[0].tone;
    const active = list.some((a) => a.id === activeAnnotationId);
    return (
      <button
        type="button"
        className={`annotation-marker ${tone} ${active ? 'active' : ''}`}
        title={list.map((a) => a.title).join('\n')}
        onClick={(e) => {
          e.stopPropagation();
          onAnnotationClick?.(active ? list.find((a) => a.id === activeAnnotationId)!.id : list[0].id);
        }}
      >
        <Icon name="sparkle" size={11} />
        {list.length > 1 ? <span className="annotation-count">{list.length}</span> : null}
      </button>
    );
  };
  const annotationRow = (newNo: number | null, colSpan: number) => {
    if (newNo === null || activeLine !== newNo || !renderAnnotationCard) return null;
    const ids = (annotationsByLine.get(newNo) ?? []).map((a) => a.id);
    if (!ids.length) return null;
    return (
      <tr className="annotation-row" key={`ann-${newNo}`}>
        <td colSpan={colSpan}>{renderAnnotationCard(ids)}</td>
      </tr>
    );
  };

  // -------------------------------------------------------------------------
  // Blame gutter: one extra leftmost column, drawn per-line but styled to
  // look like a single block for each run of consecutive lines from the same
  // commit (see blameByLine/blameRange below).
  // -------------------------------------------------------------------------
  const blameByLine = useMemo(() => {
    const map = new Map<number, BlameHunk>();
    for (const h of blame ?? []) for (let l = h.startLine; l < h.startLine + h.lineCount; l++) map.set(l, h);
    return map;
  }, [blame]);
  const blameRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const h of blame ?? []) {
      if (h.sha === ZERO_SHA) continue;
      const t = new Date(h.author.date).getTime();
      if (!Number.isNaN(t)) {
        min = Math.min(min, t);
        max = Math.max(max, t);
      }
    }
    return min <= max ? { min, max } : null;
  }, [blame]);
  const blameAgeStyle = (hunk: BlameHunk): React.CSSProperties => {
    if (hunk.sha === ZERO_SHA) return { background: 'var(--bg-subtle)', borderLeft: '3px dashed var(--fg-muted)' };
    if (!blameRange) return { background: 'var(--diff-hunk-bg)' };
    const t = new Date(hunk.author.date).getTime();
    const age = Number.isNaN(t) ? 0.5 : blameRange.max <= blameRange.min ? 0 : (blameRange.max - t) / (blameRange.max - blameRange.min);
    // The gutter background is always a light-to-mid blue tint (54%-88% lightness), so it
    // needs a fixed dark foreground for legible text in both light and dark themes — letting
    // it inherit the theme's default text color (e.g. light text in dark mode) makes it
    // unreadable against this always-light background.
    return { background: `hsl(212, 60%, ${88 - age * 34}%)`, color: '#0b1220' };
  };
  const blameActiveLine = useMemo(() => {
    if (!activeBlameId || !blame) return null;
    const hunk = blame.find((h) => blameBlockId(h) === activeBlameId);
    return hunk ? hunk.startLine + hunk.lineCount - 1 : null;
  }, [blame, activeBlameId]);
  useEffect(() => {
    if (blameActiveLine === null || !tableRef.current) return;
    tableRef.current.querySelector<HTMLElement>(`tr[data-new-line="${blameActiveLine}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [blameActiveLine]);
  const blameCell = (newNo: number | null) => {
    if (!blame) return null;
    const hunk = newNo === null ? undefined : blameByLine.get(newNo);
    if (!hunk) return <td className="blame-cell empty" />;
    const isFirst = newNo === hunk.startLine;
    const id = blameBlockId(hunk);
    const isZero = hunk.sha === ZERO_SHA;
    return (
      <td className={`blame-cell ${isFirst ? 'first' : ''} ${activeBlameId === id ? 'active' : ''}`} style={blameAgeStyle(hunk)}>
        {isFirst ? (
          <button type="button" className="blame-block" onClick={() => onBlameBlockClick?.(id)}>
            {isZero ? <span className="blame-uncommitted">Not committed yet</span> : (
              <>
                <span className="blame-sha mono">{hunk.shortSha}</span>
                <span className="blame-author truncate">{hunk.author.name}</span>
              </>
            )}
          </button>
        ) : null}
      </td>
    );
  };
  const blameCardRow = (newNo: number | null, colSpan: number) => {
    if (newNo === null || newNo !== blameActiveLine || !renderBlameCard || !activeBlameId || !blame) return null;
    const hunk = blame.find((h) => blameBlockId(h) === activeBlameId);
    if (!hunk) return null;
    return (
      <tr className="blame-card-row" key={`blame-${newNo}`}>
        <td colSpan={colSpan}>{renderBlameCard(hunk)}</td>
      </tr>
    );
  };

  const newLines = useMemo(() => splitContent(diff.newContent), [diff.newContent]);
  const oldLines = useMemo(() => splitContent(diff.oldContent), [diff.oldContent]);
  const hlNew = useMemo(() => (syntax && diff.newContent !== null ? highlightToLines(diff.newContent, diff.language) : null), [syntax, diff.newContent, diff.language]);
  const hlOld = useMemo(() => (syntax && diff.oldContent !== null ? highlightToLines(diff.oldContent, diff.language) : null), [syntax, diff.oldContent, diff.language]);
  const views = useMemo(() => buildViews(diff.hunks, newLines, expansions), [diff.hunks, newLines, expansions]);

  const allKeys = useMemo(() => {
    const keys: string[] = [];
    diff.hunks.forEach((h, hi) => h.lines.forEach((l, li) => (l.type === 'add' || l.type === 'delete') && keys.push(`${hi}:${li}`)));
    return keys;
  }, [diff.hunks]);
  const selected = useMemo(() => (selectedLines === null ? new Set(allKeys) : new Set(selectedLines)), [selectedLines, allKeys]);

  // Intraline ranges per line key (computed for paired delete/add lines).
  const intralineMap = useMemo(() => {
    const map = new Map<string, CharRange[]>();
    if (!intraline) return map;
    diff.hunks.forEach((h, hi) => {
      for (const pair of pairLines(h, hi)) {
        if (pair.left && pair.right && pair.left.line.type === 'delete' && pair.right.line.type === 'add') {
          const r = intralineDiff(pair.left.line.text, pair.right.line.text);
          if (r) {
            map.set(pair.left.key, r.old);
            map.set(pair.right.key, r.new);
          }
        }
      }
    });
    return map;
  }, [diff.hunks, intraline]);

  const renderCode = useCallback(
    (line: DiffLine, key: string): string => {
      let html: string | null = null;
      if (line.type === 'delete' && line.oldLineNumber !== null && hlOld && hlOld[line.oldLineNumber - 1] !== undefined && oldLines && oldLines[line.oldLineNumber - 1] === line.text) html = hlOld[line.oldLineNumber - 1];
      else if (line.type !== 'delete' && line.newLineNumber !== null && hlNew && hlNew[line.newLineNumber - 1] !== undefined && newLines && newLines[line.newLineNumber - 1] === line.text) html = hlNew[line.newLineNumber - 1];
      if (html === null) html = escapeHtml(line.text);
      const ranges = intralineMap.get(key);
      if (ranges && ranges.length) html = markHtml(html, ranges, line.type === 'add' ? 'word-add' : 'word-del');
      return html || ' ';
    },
    [hlNew, hlOld, newLines, oldLines, intralineMap],
  );

  const renderExtra = useCallback(
    (text: string, newNo: number): string => {
      if (hlNew && hlNew[newNo - 1] !== undefined) return hlNew[newNo - 1] || ' ';
      return escapeHtml(text) || ' ';
    },
    [hlNew],
  );

  // Selection interactions
  const dragRef = useRef<{ value: boolean; last: string } | null>(null);
  const lastClicked = useRef<string | null>(null);
  const commitSelection = useCallback(
    (next: Set<string>) => {
      onSelectionChange?.(next, allKeys.length);
    },
    [onSelectionChange, allKeys.length],
  );
  const toggleKey = useCallback(
    (key: string, shift: boolean) => {
      const next = new Set(selected);
      if (shift && lastClicked.current) {
        const a = allKeys.indexOf(lastClicked.current);
        const b = allKeys.indexOf(key);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const value = !next.has(key);
          for (let i = lo; i <= hi; i++) {
            if (value) next.add(allKeys[i]);
            else next.delete(allKeys[i]);
          }
          lastClicked.current = key;
          commitSelection(next);
          return;
        }
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      lastClicked.current = key;
      commitSelection(next);
    },
    [selected, allKeys, commitSelection],
  );
  const startDrag = useCallback(
    (key: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const value = !selected.has(key);
      dragRef.current = { value, last: key };
      const next = new Set(selected);
      if (value) next.add(key);
      else next.delete(key);
      lastClicked.current = key;
      commitSelection(next);
    },
    [selected, commitSelection],
  );
  const dragOver = useCallback(
    (key: string) => {
      const d = dragRef.current;
      if (!d || d.last === key) return;
      d.last = key;
      const next = new Set(selected);
      if (d.value) next.add(key);
      else next.delete(key);
      commitSelection(next);
    },
    [selected, commitSelection],
  );
  useEffect(() => {
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const toggleHunk = (hunkIndex: number) => {
    const keys = allKeys.filter((k) => k.startsWith(`${hunkIndex}:`));
    const allOn = keys.every((k) => selected.has(k));
    const next = new Set(selected);
    for (const k of keys) {
      if (allOn) next.delete(k);
      else next.add(k);
    }
    commitSelection(next);
  };

  const expand = (hunkIndex: number, dir: 'up' | 'down', amount: number) => {
    setExpansions((e) => ({ ...e, [`${hunkIndex}:${dir}`]: (e[`${hunkIndex}:${dir}`] ?? 0) + amount }));
  };

  const selCell = (entry: { line: DiffLine; key: string } | null) => {
    if (!selectable) return null;
    if (!entry || entry.line.type === 'context') return <td className="sel cell-empty-sel" />;
    const on = selected.has(entry.key);
    return (
      <td className={`sel ${on ? 'on' : ''} ${entry.line.type === 'add' ? 'add-num' : 'del-num'}`} onMouseDown={(e) => startDrag(entry.key, e)} onMouseEnter={() => dragOver(entry.key)} onClick={(e) => e.shiftKey && toggleKey(entry.key, true)} title={on ? 'Exclude line from commit' : 'Include line in commit'}>
        <Icon name="check" size={12} />
      </td>
    );
  };

  const hunkHeaderRow = (v: HunkView, colSpan: number) => {
    const keys = allKeys.filter((k) => k.startsWith(`${v.hunkIndex}:`));
    const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
    return (
      <tr className="hunk" key={`h${v.hunkIndex}`}>
        <td colSpan={colSpan}>
          <div className="hunk-header">
            <span className="hunk-actions">
              {v.canExpandUp > 0 ? (
                <>
                  <button type="button" onClick={() => expand(v.hunkIndex, 'up', EXPAND_STEP)} title={`Show ${Math.min(EXPAND_STEP, v.canExpandUp)} more lines above`}>
                    <Icon name="arrow-up" size={12} />
                  </button>
                  {v.canExpandUp > EXPAND_STEP ? (
                    <button type="button" onClick={() => expand(v.hunkIndex, 'up', v.canExpandUp)} title="Show all lines above">
                      all
                    </button>
                  ) : null}
                </>
              ) : null}
            </span>
            <span className="selectable">{v.hunk.header}</span>
            {selectable && keys.length ? (
              <span className="hunk-actions" style={{ marginLeft: 'auto' }}>
                <button type="button" onClick={() => toggleHunk(v.hunkIndex)}>{allOn ? 'Deselect hunk' : 'Select hunk'}</button>
              </span>
            ) : null}
          </div>
        </td>
      </tr>
    );
  };

  const noNewline = (line: DiffLine) => (line.noNewline ? <span className="no-newline"> ⏎ No newline at end of file</span> : null);

  // Explain selected lines: a right-click over an active text selection (or, with no selection, the clicked row alone)
  // offers "Explain N selected lines"/"Explain this line", scoped to the single hunk the clicked row belongs to.
  const handleExplainContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onExplainRange) return;
      const table = tableRef.current;
      if (!table) return;
      const clickedRow = (e.target as HTMLElement).closest<HTMLElement>('tr[data-key]');
      let rows: HTMLElement[] = [];
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        rows = Array.from(table.querySelectorAll<HTMLElement>('tr[data-key]')).filter((r) => range.intersectsNode(r));
      }
      if (!rows.length && clickedRow) rows = [clickedRow];
      if (!rows.length) return;
      const hunkIndex = Number(rows[0].dataset.key!.split(':')[0]);
      const sameHunk = rows.filter((r) => Number(r.dataset.key!.split(':')[0]) === hunkIndex);
      const lineNumbers = sameHunk.map((r) => (r.dataset.newLine !== undefined ? Number(r.dataset.newLine) : null)).filter((n): n is number => n !== null);
      if (!lineNumbers.length) return;
      const startLine = Math.min(...lineNumbers);
      const endLine = Math.max(...lineNumbers);
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e, [
        {
          label: lineNumbers.length > 1 ? `Explain ${lineNumbers.length} selected lines` : 'Explain this line',
          onClick: () => onExplainRange(hunkIndex, startLine, endLine),
        },
      ]);
    },
    [onExplainRange],
  );

  if (mode === 'split') {
    const colSpan = (selectable ? 6 : 4) + (blame ? 1 : 0);
    return (
      <table ref={tableRef} className={`diff split ${wrap ? 'wrap' : 'nowrap'}`} onContextMenu={handleExplainContextMenu}>
        <colgroup>
          {blame ? <col style={{ width: '14ch' }} /> : null}
          {selectable ? <col style={{ width: 22 }} /> : null}
          <col style={{ width: 50 }} />
          <col />
          {selectable ? <col style={{ width: 22 }} /> : null}
          <col style={{ width: 50 }} />
          <col />
        </colgroup>
        <tbody>
          {views.map((v) => (
            <React.Fragment key={v.hunkIndex}>
              {hunkHeaderRow(v, colSpan)}
              {v.above.map((x) => (
                <tr key={`a${x.newNo}`} className="context extra">
                  {blameCell(x.newNo)}
                  {selectable ? <td className="sel" /> : null}
                  <td className="num">{x.oldNo}</td>
                  <td className="code" dangerouslySetInnerHTML={{ __html: renderExtra(x.text, x.newNo) }} />
                  {selectable ? <td className="sel" /> : null}
                  <td className="num">{x.newNo}</td>
                  <td className="code" dangerouslySetInnerHTML={{ __html: renderExtra(x.text, x.newNo) }} />
                </tr>
              ))}
              {pairLines(v.hunk, v.hunkIndex).map((p, idx) => {
                const leftType = p.left?.line.type ?? 'empty';
                const rightType = p.right?.line.type ?? 'empty';
                const rowClass = leftType === 'delete' && rightType === 'add' ? 'modified' : leftType === 'delete' ? 'delete' : rightType === 'add' ? 'add' : 'context';
                const rightNo = p.right?.line.newLineNumber ?? null;
                const pairMatches = (!!p.left && p.left.key === highlightKey) || (!!p.right && p.right.key === highlightKey);
                return (
                  <React.Fragment key={idx}>
                  <tr className={`${rowClass} ${(p.left && selected.has(p.left.key) && p.left.line.type !== 'context') || (p.right && selected.has(p.right.key) && p.right.line.type !== 'context') ? 'selected-line' : ''} ${rightNo !== null && annotationsByLine.has(rightNo) ? 'annotated' : ''} ${pairMatches ? 'highlight-match' : ''}`} data-new-line={rightNo ?? undefined} data-key={p.left?.key ?? p.right?.key ?? undefined}>
                    {blameCell(rightNo)}
                    {selCell(p.left)}
                    {p.left ? (
                      <>
                        <td className={`num ${p.left.line.type === 'delete' ? 'del-num' : ''}`}>{p.left.line.oldLineNumber}</td>
                        <td className={`code ${p.left.line.type === 'delete' ? 'del-code' : ''}`}>
                          <span dangerouslySetInnerHTML={{ __html: renderCode(p.left.line, p.left.key) }} />
                          {noNewline(p.left.line)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="num cell-empty" />
                        <td className="code cell-empty" />
                      </>
                    )}
                    {selCell(p.right)}
                    {p.right ? (
                      <>
                        <td className={`num ${p.right.line.type === 'add' ? 'add-num' : ''}`}>
                          {p.right.line.newLineNumber}
                          {annotationMarker(rightNo)}
                        </td>
                        <td className={`code ${p.right.line.type === 'add' ? 'add-code' : ''}`}>
                          <span dangerouslySetInnerHTML={{ __html: renderCode(p.right.line, p.right.key) }} />
                          {noNewline(p.right.line)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="num cell-empty" />
                        <td className="code cell-empty" />
                      </>
                    )}
                  </tr>
                  {annotationRow(rightNo, colSpan)}
                  {blameCardRow(rightNo, colSpan)}
                  </React.Fragment>
                );
              })}
              {v.below.map((x) => (
                <tr key={`b${x.newNo}`} className="context extra">
                  {blameCell(x.newNo)}
                  {selectable ? <td className="sel" /> : null}
                  <td className="num">{x.oldNo}</td>
                  <td className="code" dangerouslySetInnerHTML={{ __html: renderExtra(x.text, x.newNo) }} />
                  {selectable ? <td className="sel" /> : null}
                  <td className="num">{x.newNo}</td>
                  <td className="code" dangerouslySetInnerHTML={{ __html: renderExtra(x.text, x.newNo) }} />
                </tr>
              ))}
              {v.hunkIndex === views.length - 1 && v.canExpandDown > 0 ? (
                <tr className="expander" key="exp-bottom">
                  <td colSpan={colSpan}>
                    <button type="button" onClick={() => expand(v.hunkIndex, 'down', EXPAND_STEP)}>
                      <Icon name="arrow-down" size={12} /> Show {Math.min(EXPAND_STEP, v.canExpandDown)} more lines
                    </button>
                    {v.canExpandDown > EXPAND_STEP ? <button type="button" onClick={() => expand(v.hunkIndex, 'down', v.canExpandDown)}>Show all {v.canExpandDown} lines</button> : null}
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    );
  }

  const colSpan = (selectable ? 5 : 4) + (blame ? 1 : 0);
  return (
    <table ref={tableRef} className={`diff unified ${wrap ? 'wrap' : 'nowrap'}`} onContextMenu={handleExplainContextMenu}>
      <colgroup>
        {blame ? <col style={{ width: '14ch' }} /> : null}
        {selectable ? <col style={{ width: 22 }} /> : null}
        <col style={{ width: 50 }} />
        <col style={{ width: 50 }} />
        <col style={{ width: 18 }} />
        <col />
      </colgroup>
      <tbody>
        {views.map((v) => (
          <React.Fragment key={v.hunkIndex}>
            {hunkHeaderRow(v, colSpan)}
            {v.above.map((x) => (
              <tr key={`a${x.newNo}`} className="context extra">
                {blameCell(x.newNo)}
                {selectable ? <td className="sel" /> : null}
                <td className="num">{x.oldNo}</td>
                <td className="num">{x.newNo}</td>
                <td className="marker" />
                <td className="code" dangerouslySetInnerHTML={{ __html: renderExtra(x.text, x.newNo) }} />
              </tr>
            ))}
            {v.hunk.lines.map((line, li) => {
              const key = `${v.hunkIndex}:${li}`;
              const isChange = line.type !== 'context';
              return (
                <React.Fragment key={li}>
                <tr className={`${line.type} ${isChange && selected.has(key) ? 'selected-line' : ''} ${line.newLineNumber !== null && annotationsByLine.has(line.newLineNumber) ? 'annotated' : ''} ${key === highlightKey ? 'highlight-match' : ''}`} data-new-line={line.newLineNumber ?? undefined} data-key={key}>
                  {blameCell(line.newLineNumber)}
                  {selCell(isChange ? { line, key } : null)}
                  <td className="num">{line.oldLineNumber ?? ''}</td>
                  <td className="num">
                    {line.newLineNumber ?? ''}
                    {annotationMarker(line.newLineNumber)}
                  </td>
                  <td className="marker">{line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ''}</td>
                  <td className="code">
                    <span dangerouslySetInnerHTML={{ __html: renderCode(line, key) }} />
                    {noNewline(line)}
                  </td>
                </tr>
                {annotationRow(line.newLineNumber, colSpan)}
                {blameCardRow(line.newLineNumber, colSpan)}
                </React.Fragment>
              );
            })}
            {v.below.map((x) => (
              <tr key={`b${x.newNo}`} className="context extra">
                {blameCell(x.newNo)}
                {selectable ? <td className="sel" /> : null}
                <td className="num">{x.oldNo}</td>
                <td className="num">{x.newNo}</td>
                <td className="marker" />
                <td className="code" dangerouslySetInnerHTML={{ __html: renderExtra(x.text, x.newNo) }} />
              </tr>
            ))}
            {v.hunkIndex === views.length - 1 && v.canExpandDown > 0 ? (
              <tr className="expander">
                <td colSpan={colSpan}>
                  <button type="button" onClick={() => expand(v.hunkIndex, 'down', EXPAND_STEP)}>
                    <Icon name="arrow-down" size={12} /> Show {Math.min(EXPAND_STEP, v.canExpandDown)} more lines
                  </button>
                  {v.canExpandDown > EXPAND_STEP ? <button type="button" onClick={() => expand(v.hunkIndex, 'down', v.canExpandDown)}>Show all {v.canExpandDown} lines</button> : null}
                </td>
              </tr>
            ) : null}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}
