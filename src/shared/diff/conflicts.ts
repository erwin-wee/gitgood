import type { ConflictBlock } from '../types';
import { joinLines, splitLines } from '../util';

export interface ParsedConflicts {
  lines: string[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
  blocks: ConflictBlock[];
  oursLabel: string;
  theirsLabel: string;
}

const OURS_RE = /^<{7,}(?: (.*))?$/;
const BASE_RE = /^\|{7,}(?: (.*))?$/;
const SEP_RE = /^={7,}$/;
const THEIRS_RE = /^>{7,}(?: (.*))?$/;

export function hasConflictMarkers(content: string): boolean {
  return /^<{7,}(?: |$)/m.test(content) && /^={7,}$/m.test(content) && /^>{7,}(?: |$)/m.test(content);
}

export function parseConflicts(content: string): ParsedConflicts {
  const { lines, eol, trailingNewline } = splitLines(content);
  const blocks: ConflictBlock[] = [];
  let oursLabel = 'HEAD';
  let theirsLabel = 'incoming';
  let i = 0;
  let id = 0;
  while (i < lines.length) {
    const m = OURS_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const start = i;
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    if (m[1]) oursLabel = m[1];
    i++;
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    let closed = false;
    while (i < lines.length) {
      const l = lines[i];
      if (section === 'ours' && BASE_RE.test(l)) {
        section = 'base';
        base = [];
        i++;
        continue;
      }
      if ((section === 'ours' || section === 'base') && SEP_RE.test(l)) {
        section = 'theirs';
        i++;
        continue;
      }
      if (section === 'theirs') {
        const tm = THEIRS_RE.exec(l);
        if (tm) {
          if (tm[1]) theirsLabel = tm[1];
          i++;
          closed = true;
          break;
        }
      }
      if (section === 'ours') ours.push(l);
      else if (section === 'base') base!.push(l);
      else theirs.push(l);
      i++;
    }
    if (!closed) break;
    blocks.push({ id: id++, start, end: i, oursLabel, theirsLabel, ours, base, theirs });
  }
  return { lines, eol, trailingNewline, blocks, oursLabel, theirsLabel };
}

export type BlockChoice = 'ours' | 'theirs' | 'both' | 'both-reversed' | 'base';

export function resolutionForChoice(block: ConflictBlock, choice: BlockChoice): string[] {
  switch (choice) {
    case 'ours':
      return block.ours;
    case 'theirs':
      return block.theirs;
    case 'both':
      return [...block.ours, ...block.theirs];
    case 'both-reversed':
      return [...block.theirs, ...block.ours];
    case 'base':
      return block.base ?? [];
  }
}

/** 0-based, half-open [start, end) line range a resolved block occupies in the resulting file's line array (before joining with the line-ending convention). An empty resolution produces start === end. */
export interface ResolvedRange {
  start: number;
  end: number;
}

export interface AppliedResolutions {
  content: string;
  /** Keyed by block id; only present for blocks that received a resolution (untouched blocks, which keep their markers, are not included). */
  ranges: Map<number, ResolvedRange>;
}

/**
 * Replaces the given blocks with their resolutions and returns the new file
 * content plus the line range each resolved block ended up occupying.
 * Blocks without a resolution are left intact (markers preserved) and do not
 * appear in `ranges`.
 */
export function applyResolutions(parsed: ParsedConflicts, resolutions: Map<number, string[]>): AppliedResolutions {
  const out: string[] = [];
  const ranges = new Map<number, ResolvedRange>();
  let pos = 0;
  for (const block of parsed.blocks) {
    out.push(...parsed.lines.slice(pos, block.start));
    const res = resolutions.get(block.id);
    if (res === undefined) {
      out.push(...parsed.lines.slice(block.start, block.end));
    } else {
      const start = out.length;
      out.push(...res);
      ranges.set(block.id, { start, end: out.length });
    }
    pos = block.end;
  }
  out.push(...parsed.lines.slice(pos));
  return { content: joinLines(out, parsed.eol, parsed.trailingNewline || out.length > 0), ranges };
}

/** Normalizes a model-provided resolution string into lines matching the file's conventions. */
export function normalizeResolutionText(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
