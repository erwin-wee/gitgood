/**
 * Pure helpers for AI diff explanations: validating model output against the
 * real diff, splitting a multi-file patch back into per-file blocks, marking
 * a selected line range for the prompt, and building surrounding context
 * from file content. No Electron or Node imports so this can be unit tested
 * and reasoned about in isolation (mirrors review-core.ts).
 */
import type { DiffHunk, ExplainReference, ExplainSource, ExplainTarget, Explanation } from '@shared/types';
import { indexNewSide } from './review-core';

/** New-side line numbers present in `hunks` (the lines a reference is allowed to cite). */
export function indexNewSideLines(hunks: DiffHunk[]): Set<number> {
  return indexNewSide(hunks).lines;
}

export const EXPLAIN_MAX_SECTION_CHARS = 2000;
export const EXPLAIN_MAX_WATCH_ITEMS = 8;
export const EXPLAIN_MAX_REFERENCE_LABEL_CHARS = 200;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export interface ValidatedExplanation {
  /** Null when the model's output was invalid (e.g. an empty "whatChanged"); the caller should treat this as a failed request. */
  explanation: Explanation | null;
  droppedReferences: number;
}

/**
 * Validates raw model output for one explanation: `whatChanged` must be
 * non-empty (otherwise the whole result is rejected), text fields are
 * capped, `watchOutFor` is capped to `EXPLAIN_MAX_WATCH_ITEMS`, and every
 * reference must name a known path and (when it names a line) a line
 * present in that path's `knownPaths` set; anything else is dropped and
 * counted.
 */
export function validateExplanation(raw: unknown, model: string, truncated: boolean, knownPaths: Map<string, Set<number>>): ValidatedExplanation {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { whatChanged?: unknown; why?: unknown; impact?: unknown; watchOutFor?: unknown; references?: unknown };
  const whatChanged = typeof r.whatChanged === 'string' ? cap(r.whatChanged.trim(), EXPLAIN_MAX_SECTION_CHARS) : '';
  if (!whatChanged) return { explanation: null, droppedReferences: 0 };
  const why = typeof r.why === 'string' ? cap(r.why.trim(), EXPLAIN_MAX_SECTION_CHARS) : '';
  const impact = typeof r.impact === 'string' ? cap(r.impact.trim(), EXPLAIN_MAX_SECTION_CHARS) : '';
  const watchOutFor = (Array.isArray(r.watchOutFor) ? r.watchOutFor : [])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => cap(x.trim(), 300))
    .slice(0, EXPLAIN_MAX_WATCH_ITEMS);

  const rawRefs = Array.isArray(r.references) ? r.references : [];
  let droppedReferences = 0;
  const references: ExplainReference[] = [];
  const seen = new Set<string>();
  for (const item of rawRefs) {
    if (!item || typeof item !== 'object') {
      droppedReferences++;
      continue;
    }
    const rec = item as { path?: unknown; line?: unknown; label?: unknown };
    const path = typeof rec.path === 'string' ? rec.path : '';
    const label = typeof rec.label === 'string' ? cap(rec.label.trim(), EXPLAIN_MAX_REFERENCE_LABEL_CHARS) : '';
    const lines = knownPaths.get(path);
    if (!path || !label || lines === undefined) {
      droppedReferences++;
      continue;
    }
    let line: number | null = null;
    if (rec.line !== null && rec.line !== undefined) {
      const n = typeof rec.line === 'number' && Number.isInteger(rec.line) ? rec.line : null;
      if (n === null || !lines.has(n)) {
        droppedReferences++;
        continue;
      }
      line = n;
    }
    const key = `${path}\0${line ?? ''}\0${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ path, line, label });
  }

  return { explanation: { whatChanged, why, impact, watchOutFor, references, truncated, droppedReferences, model }, droppedReferences };
}

/** Validates a follow-up response against the `{ answer: string }` schema; returns null when empty/invalid. */
export function validateFollowUpAnswer(raw: unknown): string | null {
  const value = raw && typeof raw === 'object' ? (raw as { answer?: unknown }).answer : undefined;
  const answer = typeof value === 'string' ? cap(value.trim(), EXPLAIN_MAX_SECTION_CHARS) : '';
  return answer || null;
}

/**
 * Splits the concatenated output of `getCommitPatch` back into per-file
 * blocks keyed by the file's new path, so each file's hunks can be parsed
 * and annotated independently.
 */
export function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!patch.trim()) return map;
  const blocks = patch.split(/(?=^diff --git )/m).filter((b) => b.trim());
  for (const block of blocks) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    if (!m) continue;
    map.set(m[2], block);
  }
  return map;
}

/** Appends a "<== selected" marker to annotated lines whose [new:N] number falls within [startLine, endLine]. */
export function markSelectedRange(annotated: string, startLine: number, endLine: number): string {
  return annotated
    .split('\n')
    .map((line) => {
      const m = /\[new:\s*(\d+)\]/.exec(line);
      if (m) {
        const n = Number(m[1]);
        if (n >= startLine && n <= endLine) return `${line}  <== selected`;
      }
      return line;
    })
    .join('\n');
}

/** Splits file content into lines, tolerating CRLF and a trailing newline. */
export function splitFileLines(content: string | null): string[] | null {
  if (content === null) return null;
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length && lines[lines.length - 1] === '' && normalized.endsWith('\n')) lines.pop();
  return lines;
}

function sourceCacheKey(source: ExplainSource): string {
  switch (source.kind) {
    case 'commit':
      return `commit:${source.sha}`;
    case 'working':
      return 'working';
    case 'stash':
      return `stash:${source.ref}`;
  }
}

/**
 * True when the target reads the working tree, whose content can change between
 * two explains. A commit or stash source is immutable, so its cache key alone
 * identifies its content; `sourceCacheKey` returns a constant for `working`, so
 * a cached entry for one of these must be revalidated before it is reused.
 */
export function isVolatileExplainTarget(target: ExplainTarget): boolean {
  return target.kind !== 'commit' && target.source.kind === 'working';
}

/** Stable cache/dedupe key for a target, used both by the in-memory explanation cache and to detect a superseded request in the renderer. */
export function explainCacheKey(target: ExplainTarget): string {
  switch (target.kind) {
    case 'commit':
      return `commit:${target.sha}`;
    case 'file':
      return `file:${sourceCacheKey(target.source)}:${target.path}`;
    case 'range':
      return `range:${sourceCacheKey(target.source)}:${target.path}:${target.hunkIndex}:${target.startLine}-${target.endLine}`;
  }
}

/** Numbered lines of the new (or old, for a deletion) file content around `hunk`, up to `contextLines` on each side. */
export function buildRangeContext(newContent: string | null, oldContent: string | null, hunk: DiffHunk, contextLines: number): string {
  const lines = splitFileLines(newContent ?? oldContent);
  if (!lines || !lines.length) return '';
  const endNew = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  const start = Math.max(1, hunk.newStart - contextLines);
  const end = Math.min(lines.length, endNew + contextLines);
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(`${String(n).padStart(5)}  ${lines[n - 1] ?? ''}`);
  return out.join('\n');
}
