import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BlameHunk, DiffHunk, DiffLine, FileDiff } from '@shared/types';
import { ZERO_SHA } from '@shared/types';
import { intralineDiff, type CharRange } from '@shared/diff/intraline';
import { escapeHtml } from '@shared/util';
import { highlightToLines } from '../../lib/highlight';
import { useWindowedRows } from '../../lib/windowing';
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

/**
 * Syntax highlighting runs lazily per block of file lines as rows scroll into
 * view, so opening a diff never pays for lines that are not on screen.
 * ponytail: block boundaries can split a multi-line token (a block comment),
 * mis-colouring a few lines at the seam; highlight whole files in a worker if that matters.
 */
const HIGHLIGHT_BLOCK_LINES = 400;
/** Blocks with a longer line than this (minified code) are shown unhighlighted: hljs is superlinear on them. */
const HIGHLIGHT_MAX_LINE_CHARS = 5000;

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

interface Entry {
  line: DiffLine;
  key: string;
  index: number;
}

interface Pair {
  left: Entry | null;
  right: Entry | null;
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
    const dels: Entry[] = [];
    const adds: Entry[] = [];
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

/** One table row of the flattened diff; the windowed renderer only materialises the rows in view. */
type Row =
  | { kind: 'hunk'; v: HunkView }
  | { kind: 'extra'; x: ExtraLine; hunkIndex: number }
  | { kind: 'line'; line: DiffLine; key: string; hunkIndex: number }
  | { kind: 'pair'; p: Pair; hunkIndex: number; idx: number }
  | { kind: 'card'; what: 'annotation' | 'blame'; newNo: number }
  | { kind: 'expander'; v: HunkView };

function rowKey(r: Row): string {
  switch (r.kind) {
    case 'hunk': return `h${r.v.hunkIndex}`;
    case 'extra': return `x${r.x.newNo}`;
    case 'line': return r.key;
    case 'pair': return `p${r.hunkIndex}:${r.idx}`;
    case 'card': return `${r.what}${r.newNo}`;
    case 'expander': return 'expander';
  }
}

function rowNewNo(r: Row): number | null {
  switch (r.kind) {
    case 'extra': return r.x.newNo;
    case 'line': return r.line.newLineNumber;
    case 'pair': return r.p.right?.line.newLineNumber ?? null;
    default: return null;
  }
}

const ROW_ESTIMATES = { hunk: 28, extra: 20, line: 20, pair: 20, card: 140, expander: 28 };

export function TextDiff({ diff, mode, wrap, syntax, intraline, selectable, selectedLines, onSelectionChange, annotations, activeAnnotationId, onAnnotationClick, renderAnnotationCard, blame, activeBlameId, onBlameBlockClick, renderBlameCard, highlightTerm, onExplainRange }: TextDiffProps): React.JSX.Element {
  const [expansions, setExpansions] = useState<Record<string, number>>({});
  useEffect(() => setExpansions({}), [diff]);
  const tableRef = useRef<HTMLTableElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setContainer(tableRef.current?.parentElement ?? null), []);

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

  const newLines = useMemo(() => splitContent(diff.newContent), [diff.newContent]);
  const oldLines = useMemo(() => splitContent(diff.oldContent), [diff.oldContent]);
  const views = useMemo(() => buildViews(diff.hunks, newLines, expansions), [diff.hunks, newLines, expansions]);

  // Lazy highlighting: per-side blocks of file lines, computed the first time a row in the block renders.
  const hlCache = useRef(new Map<string, string[] | null>());
  useMemo(() => hlCache.current.clear(), [syntax, diff.newContent, diff.oldContent, diff.language]);
  const highlighted = useCallback(
    (side: 'old' | 'new', lineNo: number): string | undefined => {
      const lines = side === 'new' ? newLines : oldLines;
      if (!syntax || !lines || lineNo < 1 || lineNo > lines.length) return undefined;
      const block = Math.floor((lineNo - 1) / HIGHLIGHT_BLOCK_LINES);
      const cacheKey = `${side}:${block}`;
      let html = hlCache.current.get(cacheKey);
      if (html === undefined) {
        const from = block * HIGHLIGHT_BLOCK_LINES;
        const chunk = lines.slice(from, from + HIGHLIGHT_BLOCK_LINES);
        html = chunk.some((l) => l.length > HIGHLIGHT_MAX_LINE_CHARS) ? null : highlightToLines(chunk.join('\n'), diff.language);
        if (html && html.length !== chunk.length) html = null;
        hlCache.current.set(cacheKey, html);
      }
      return html ? html[(lineNo - 1) % HIGHLIGHT_BLOCK_LINES] : undefined;
    },
    [syntax, newLines, oldLines, diff.language],
  );

  const allKeys = useMemo(() => {
    const keys: string[] = [];
    diff.hunks.forEach((h, hi) => h.lines.forEach((l, li) => (l.type === 'add' || l.type === 'delete') && keys.push(`${hi}:${li}`)));
    return keys;
  }, [diff.hunks]);
  const keysByHunk = useMemo(() => {
    const by: string[][] = diff.hunks.map(() => []);
    for (const k of allKeys) by[Number(k.slice(0, k.indexOf(':')))].push(k);
    return by;
  }, [allKeys, diff.hunks]);
  const selected = useMemo(() => (selectedLines === null ? new Set(allKeys) : new Set(selectedLines)), [selectedLines, allKeys]);

  // Split-view pairs per hunk, and lazily computed intraline ranges per line key.
  const pairsCache = useRef(new Map<number, Pair[]>());
  const pairByKey = useRef(new Map<string, Pair>());
  const intralineCache = useRef(new Map<string, CharRange[]>());
  useMemo(() => {
    pairsCache.current.clear();
    pairByKey.current.clear();
    intralineCache.current.clear();
  }, [diff.hunks, intraline]);
  const pairsOf = useCallback((hunkIndex: number): Pair[] => {
    let pairs = pairsCache.current.get(hunkIndex);
    if (!pairs) {
      pairs = pairLines(diff.hunks[hunkIndex], hunkIndex);
      pairsCache.current.set(hunkIndex, pairs);
      if (intraline) {
        for (const pair of pairs) {
          if (pair.left && pair.right && pair.left.line.type === 'delete' && pair.right.line.type === 'add') {
            pairByKey.current.set(pair.left.key, pair);
            pairByKey.current.set(pair.right.key, pair);
          }
        }
      }
    }
    return pairs;
  }, [diff.hunks, intraline]);

  const renderCode = useCallback(
    (line: DiffLine, key: string, hunkIndex: number): string => {
      let html: string | undefined;
      if (line.type === 'delete' && line.oldLineNumber !== null && oldLines && oldLines[line.oldLineNumber - 1] === line.text) html = highlighted('old', line.oldLineNumber);
      else if (line.type !== 'delete' && line.newLineNumber !== null && newLines && newLines[line.newLineNumber - 1] === line.text) html = highlighted('new', line.newLineNumber);
      if (html === undefined) html = escapeHtml(line.text);
      if (intraline && line.type !== 'context') {
        pairsOf(hunkIndex);
        // Only diff pairs whose rows render, not every pair in a large hunk.
        const pair = pairByKey.current.get(key);
        if (!intralineCache.current.has(key) && pair?.left && pair.right) {
          const r = intralineDiff(pair.left.line.text, pair.right.line.text);
          intralineCache.current.set(pair.left.key, r?.old ?? []);
          intralineCache.current.set(pair.right.key, r?.new ?? []);
        }
        const ranges = intralineCache.current.get(key);
        if (ranges && ranges.length) html = markHtml(html, ranges, line.type === 'add' ? 'word-add' : 'word-del');
      }
      return html || ' ';
    },
    [highlighted, newLines, oldLines, intraline, pairsOf],
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
    (key: string, e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  const toggleHunk = (hunkIndex: number) => {
    const keys = keysByHunk[hunkIndex];
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
      <td className={'sel ' + (on ? 'on' : '') + ' ' + (entry.line.type === 'add' ? 'add-num' : 'del-num')} onPointerDown={(e) => startDrag(entry.key, e)} onPointerEnter={() => dragOver(entry.key)} onClick={(e) => e.shiftKey && toggleKey(entry.key, true)} title={on ? 'Exclude line from commit' : 'Include line in commit'}>
        <Icon name="check" size={12} />
      </td>
    );
  };

  const split = mode === 'split';
  const colSpan = (split ? (selectable ? 6 : 4) : selectable ? 5 : 4) + (blame ? 1 : 0);

  const hunkHeaderRow = (v: HunkView) => {
    const keys = keysByHunk[v.hunkIndex];
    const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
    return (
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

  // -------------------------------------------------------------------------
  // Flatten hunks into rows, then render only the windowed slice.
  // -------------------------------------------------------------------------
  const showAnnotationCard = !!renderAnnotationCard && activeLine !== null;
  const showBlameCard = !!renderBlameCard && !!activeBlameId && !!blame && blameActiveLine !== null;
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const cardsFor = (newNo: number | null) => {
      if (newNo === null) return;
      if (showAnnotationCard && newNo === activeLine && (annotationsByLine.get(newNo)?.length ?? 0) > 0) out.push({ kind: 'card', what: 'annotation', newNo });
      if (showBlameCard && newNo === blameActiveLine) out.push({ kind: 'card', what: 'blame', newNo });
    };
    for (const v of views) {
      out.push({ kind: 'hunk', v });
      for (const x of v.above) out.push({ kind: 'extra', x, hunkIndex: v.hunkIndex });
      if (split) {
        pairsOf(v.hunkIndex).forEach((p, idx) => {
          out.push({ kind: 'pair', p, hunkIndex: v.hunkIndex, idx });
          cardsFor(p.right?.line.newLineNumber ?? null);
        });
      } else {
        v.hunk.lines.forEach((line, li) => {
          out.push({ kind: 'line', line, key: `${v.hunkIndex}:${li}`, hunkIndex: v.hunkIndex });
          cardsFor(line.newLineNumber);
        });
      }
      for (const x of v.below) out.push({ kind: 'extra', x, hunkIndex: v.hunkIndex });
      if (v.hunkIndex === views.length - 1 && v.canExpandDown > 0) out.push({ kind: 'expander', v });
    }
    return out;
  }, [views, split, pairsOf, showAnnotationCard, activeLine, annotationsByLine, showBlameCard, blameActiveLine]);

  const kindOf = useCallback((i: number) => rows[i].kind, [rows]);
  const resetKey = useMemo(() => ({}), [diff.hunks, wrap, split, !!blame]);
  const win = useWindowedRows(container, { count: rows.length, kindOf, estimates: ROW_ESTIMATES, resetKey });

  // Keeps the unified nowrap table from re-sizing as long lines scroll in and out of the window.
  const longestLine = useMemo(() => {
    let n = 0;
    for (const h of diff.hunks) for (const l of h.lines) if (l.text.length > n) n = l.text.length;
    return n;
  }, [diff.hunks]);

  // Reads rows through a ref so the scroll-to effects below fire only when their target changes, not when a hunk expands or a card opens.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const scrollToRow = useCallback(
    (pred: (r: Row) => boolean, align: 'center' | 'nearest') => {
      const i = rowsRef.current.findIndex(pred);
      if (i !== -1) win.scrollTo(i, align);
    },
    [win.scrollTo],
  );
  useEffect(() => {
    if (activeLine !== null) scrollToRow((r) => rowNewNo(r) === activeLine, 'center');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLine, diff]);
  useEffect(() => {
    if (highlightKey) scrollToRow((r) => (r.kind === 'line' && r.key === highlightKey) || (r.kind === 'pair' && (r.p.left?.key === highlightKey || r.p.right?.key === highlightKey)), 'center');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey, diff]);
  useEffect(() => {
    if (blameActiveLine !== null) scrollToRow((r) => rowNewNo(r) === blameActiveLine, 'nearest');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blameActiveLine]);

  const renderRow = (r: Row, i: number): React.ReactNode => {
    const ref = win.rowRef(i);
    switch (r.kind) {
      case 'hunk':
        return <tr ref={ref} key={rowKey(r)} className="hunk">{hunkHeaderRow(r.v)}</tr>;
      case 'extra': {
        const x = r.x;
        const html = (highlighted('new', x.newNo) ?? escapeHtml(x.text)) || ' ';
        return (
          <tr ref={ref} key={rowKey(r)} className="context extra">
            {blameCell(x.newNo)}
            {selectable ? <td className="sel" /> : null}
            <td className="num">{x.oldNo}</td>
            {split ? (
              <>
                <td className="code" dangerouslySetInnerHTML={{ __html: html }} />
                {selectable ? <td className="sel" /> : null}
                <td className="num">{x.newNo}</td>
                <td className="code" dangerouslySetInnerHTML={{ __html: html }} />
              </>
            ) : (
              <>
                <td className="num">{x.newNo}</td>
                <td className="marker" />
                <td className="code" dangerouslySetInnerHTML={{ __html: html }} />
              </>
            )}
          </tr>
        );
      }
      case 'line': {
        const { line, key } = r;
        const isChange = line.type !== 'context';
        return (
          <tr ref={ref} key={key} className={`${line.type} ${isChange && selected.has(key) ? 'selected-line' : ''} ${line.newLineNumber !== null && annotationsByLine.has(line.newLineNumber) ? 'annotated' : ''} ${key === highlightKey ? 'highlight-match' : ''}`} data-new-line={line.newLineNumber ?? undefined} data-key={key}>
            {blameCell(line.newLineNumber)}
            {selCell(isChange ? { line, key } : null)}
            <td className="num">{line.oldLineNumber ?? ''}</td>
            <td className="num">
              {line.newLineNumber ?? ''}
              {annotationMarker(line.newLineNumber)}
            </td>
            <td className="marker">{line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ''}</td>
            <td className="code">
              <span dangerouslySetInnerHTML={{ __html: renderCode(line, key, r.hunkIndex) }} />
              {noNewline(line)}
            </td>
          </tr>
        );
      }
      case 'pair': {
        const p = r.p;
        const leftType = p.left?.line.type ?? 'empty';
        const rightType = p.right?.line.type ?? 'empty';
        const rowClass = leftType === 'delete' && rightType === 'add' ? 'modified' : leftType === 'delete' ? 'delete' : rightType === 'add' ? 'add' : 'context';
        const rightNo = p.right?.line.newLineNumber ?? null;
        const pairMatches = (!!p.left && p.left.key === highlightKey) || (!!p.right && p.right.key === highlightKey);
        return (
          <tr ref={ref} key={rowKey(r)} className={`${rowClass} ${(p.left && selected.has(p.left.key) && p.left.line.type !== 'context') || (p.right && selected.has(p.right.key) && p.right.line.type !== 'context') ? 'selected-line' : ''} ${rightNo !== null && annotationsByLine.has(rightNo) ? 'annotated' : ''} ${pairMatches ? 'highlight-match' : ''}`} data-new-line={rightNo ?? undefined} data-key={p.left?.key ?? p.right?.key ?? undefined}>
            {blameCell(rightNo)}
            {selCell(p.left)}
            {p.left ? (
              <>
                <td className={`num ${p.left.line.type === 'delete' ? 'del-num' : ''}`}>{p.left.line.oldLineNumber}</td>
                <td className={`code ${p.left.line.type === 'delete' ? 'del-code' : ''}`}>
                  <span dangerouslySetInnerHTML={{ __html: renderCode(p.left.line, p.left.key, r.hunkIndex) }} />
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
                  <span dangerouslySetInnerHTML={{ __html: renderCode(p.right.line, p.right.key, r.hunkIndex) }} />
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
        );
      }
      case 'card':
        if (r.what === 'annotation') {
          const ids = (annotationsByLine.get(r.newNo) ?? []).map((a) => a.id);
          return (
            <tr ref={ref} key={rowKey(r)} className="annotation-row">
              <td colSpan={colSpan}>{renderAnnotationCard!(ids)}</td>
            </tr>
          );
        }
        return (
          <tr ref={ref} key={rowKey(r)} className="blame-card-row">
            <td colSpan={colSpan}>{renderBlameCard!(blame!.find((h) => blameBlockId(h) === activeBlameId)!)}</td>
          </tr>
        );
      case 'expander': {
        const v = r.v;
        return (
          <tr ref={ref} key={rowKey(r)} className="expander">
            <td colSpan={colSpan}>
              <button type="button" onClick={() => expand(v.hunkIndex, 'down', EXPAND_STEP)}>
                <Icon name="arrow-down" size={12} /> Show {Math.min(EXPAND_STEP, v.canExpandDown)} more lines
              </button>
              {v.canExpandDown > EXPAND_STEP ? <button type="button" onClick={() => expand(v.hunkIndex, 'down', v.canExpandDown)}>Show all {v.canExpandDown} lines</button> : null}
            </td>
          </tr>
        );
      }
    }
  };

  const slice: React.ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) slice.push(renderRow(rows[i], i));

  return (
    <table ref={tableRef} className={`diff ${split ? 'split' : 'unified'} ${wrap ? 'wrap' : 'nowrap'}`} style={!split && !wrap ? { minWidth: `max(100%, ${longestLine + 24}ch)` } : undefined} onContextMenu={handleExplainContextMenu}>
      <colgroup>
        {blame ? <col style={{ width: '14ch' }} /> : null}
        {selectable ? <col style={{ width: 22 }} /> : null}
        <col style={{ width: 50 }} />
        {split ? (
          <>
            <col />
            {selectable ? <col style={{ width: 22 }} /> : null}
            <col style={{ width: 50 }} />
            <col />
          </>
        ) : (
          <>
            <col style={{ width: 50 }} />
            <col style={{ width: 18 }} />
            <col />
          </>
        )}
      </colgroup>
      <tbody>
        {win.top > 0 ? <tr aria-hidden style={{ height: win.top }}><td colSpan={colSpan} /></tr> : null}
        {slice}
        {win.bottom > 0 ? <tr aria-hidden style={{ height: win.bottom }}><td colSpan={colSpan} /></tr> : null}
      </tbody>
    </table>
  );
}
