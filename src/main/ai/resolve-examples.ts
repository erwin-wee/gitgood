import type { ManualResolutionExample } from '@shared/types';
import { hasConflictMarkers, parseConflicts } from '@shared/diff/conflicts';

const MAX_EXAMPLES = 3;
const MAX_TOTAL_BYTES = 12_000;
const CONTEXT_LINES = 20;

/** A manual resolution captured verbatim before it is trimmed down to a worked example. */
export interface RawManualResolution {
  path: string;
  /** The conflicted file content before the user's edit (with markers). */
  original: string;
  /** The file content after the user's edit (no markers). */
  resolved: string;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Trims a manual resolution to its conflict blocks plus `CONTEXT_LINES` lines
 * of surrounding context on each side, for both the original (marked) and
 * resolved text, so the model sees the reconciliation pattern without the
 * whole file. Returns null when `original` has no parseable conflict blocks
 * (nothing useful to show as an example).
 */
export function trimManualResolution(raw: RawManualResolution): ManualResolutionExample | null {
  if (!hasConflictMarkers(raw.original)) return null;
  const parsed = parseConflicts(raw.original);
  if (!parsed.blocks.length) return null;

  const origExcerpts: string[] = [];
  let prevEnd = 0;
  for (const block of parsed.blocks) {
    const beforeStart = Math.max(prevEnd, block.start - CONTEXT_LINES);
    if (beforeStart > prevEnd) origExcerpts.push('…');
    origExcerpts.push(...parsed.lines.slice(beforeStart, block.end));
    prevEnd = block.end;
  }
  const afterEnd = Math.min(parsed.lines.length, prevEnd + CONTEXT_LINES);
  if (afterEnd > prevEnd) origExcerpts.push(...parsed.lines.slice(prevEnd, afterEnd));
  if (afterEnd < parsed.lines.length) origExcerpts.push('…');

  // The resolved file has no markers to anchor on, so trim it by the same proportion: keep up to
  // CONTEXT_LINES lines from the start and end of the resolved text, which is exact for the common
  // single-block case and a reasonable approximation (never wrong, only occasionally over-inclusive)
  // for multi-block files.
  const resolvedLines = raw.resolved.replace(/\r\n/g, '\n').split('\n');
  const resolvedExcerpt =
    resolvedLines.length <= CONTEXT_LINES * 2 + parsed.blocks.length * 2
      ? resolvedLines
      : [...resolvedLines.slice(0, CONTEXT_LINES), '…', ...resolvedLines.slice(resolvedLines.length - CONTEXT_LINES)];

  return { path: raw.path, original: origExcerpts.join('\n'), resolved: resolvedExcerpt.join('\n') };
}

/**
 * Caps a set of manual resolutions to at most `MAX_EXAMPLES` entries and
 * `MAX_TOTAL_BYTES` total, most recent first, dropping whatever does not fit
 * rather than truncating an individual example further.
 */
export function capExamples(examples: ManualResolutionExample[]): ManualResolutionExample[] {
  const out: ManualResolutionExample[] = [];
  let total = 0;
  for (const ex of examples) {
    if (out.length >= MAX_EXAMPLES) break;
    const size = byteLength(ex.original) + byteLength(ex.resolved);
    if (total + size > MAX_TOTAL_BYTES) continue;
    out.push(ex);
    total += size;
  }
  return out;
}
