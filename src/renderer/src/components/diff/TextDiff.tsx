import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffHunk, DiffLine, FileDiff } from '@shared/types';
import { intralineDiff, type CharRange } from '@shared/diff/intraline';
import { escapeHtml } from '@shared/util';
import { highlightToLines } from '../../lib/highlight';
import { Icon } from '../ui';

type TextDiffData = Extract<FileDiff, { kind: 'text' }>;

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

export function TextDiff({ diff, mode, wrap, syntax, intraline, selectable, selectedLines, onSelectionChange }: TextDiffProps): React.JSX.Element {
  const [expansions, setExpansions] = useState<Record<string, number>>({});
  useEffect(() => setExpansions({}), [diff]);

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

  if (mode === 'split') {
    const colSpan = selectable ? 6 : 4;
    return (
      <table className={`diff split ${wrap ? 'wrap' : 'nowrap'}`}>
        <colgroup>
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
                return (
                  <tr key={idx} className={`${rowClass} ${(p.left && selected.has(p.left.key) && p.left.line.type !== 'context') || (p.right && selected.has(p.right.key) && p.right.line.type !== 'context') ? 'selected-line' : ''}`}>
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
                        <td className={`num ${p.right.line.type === 'add' ? 'add-num' : ''}`}>{p.right.line.newLineNumber}</td>
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
                );
              })}
              {v.below.map((x) => (
                <tr key={`b${x.newNo}`} className="context extra">
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

  const colSpan = selectable ? 5 : 4;
  return (
    <table className={`diff unified ${wrap ? 'wrap' : 'nowrap'}`}>
      <colgroup>
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
                <tr key={li} className={`${line.type} ${isChange && selected.has(key) ? 'selected-line' : ''}`}>
                  {selCell(isChange ? { line, key } : null)}
                  <td className="num">{line.oldLineNumber ?? ''}</td>
                  <td className="num">{line.newLineNumber ?? ''}</td>
                  <td className="marker">{line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ''}</td>
                  <td className="code">
                    <span dangerouslySetInnerHTML={{ __html: renderCode(line, key) }} />
                    {noNewline(line)}
                  </td>
                </tr>
              );
            })}
            {v.below.map((x) => (
              <tr key={`b${x.newNo}`} className="context extra">
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
