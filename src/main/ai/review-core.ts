/**
 * Pure helpers for AI pull request review: diff annotation for the prompt,
 * validation of model output against the real diff, skip rules and the
 * GitHub review payload. No Electron or Node imports so this can be unit
 * tested and reasoned about in isolation.
 */
import type { CommitFile, DiffHunk, ReviewCategory, ReviewFinding, ReviewSeverity, ReviewStrictness } from '@shared/types';
import { joinLines, splitLines } from '@shared/util';

export const MAX_CHANGED_LINES_PER_FILE = 1500;
export const MAX_TITLE_CHARS = 120;
export const MAX_DETAIL_CHARS = 600;
/** Findings the model places on a deleted line are moved to the next new-side line within this distance. */
export const REMAP_DISTANCE = 3;

const SEVERITIES: ReviewSeverity[] = ['blocker', 'warning', 'nit'];
const CATEGORIES: ReviewCategory[] = ['bug', 'security', 'performance', 'test-gap', 'readability', 'docs', 'style', 'intent-mismatch'];
const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocker: 0, warning: 1, nit: 2 };

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'go.sum', 'poetry.lock', 'gemfile.lock', 'composer.lock', 'pipfile.lock', 'bun.lockb', 'bun.lock', 'flake.lock']);
const GENERATED_DIRS = ['dist/', 'out/', 'build/', 'vendor/', 'node_modules/'];

/** djb2 hash rendered as hex; stable across processes without a crypto dependency. */
export function stableHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h2 ^= text.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function findingId(path: string, line: number, title: string): string {
  return stableHash(`${path}\0${line}\0${normalizeTitle(title)}`);
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

/** Serialises hunks so a re-review can tell whether a file's diff changed. */
export function hashHunks(hunks: DiffHunk[]): string {
  return stableHash(hunks.map((h) => `${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}\n${h.lines.map((l) => `${l.type[0]}${l.text}`).join('\n')}`).join('\n@@\n'));
}

/**
 * Returns the reason a file is left out of a review, or null when it should be reviewed.
 * `generatedPaths` are paths marked linguist-generated in .gitattributes.
 */
export function skipReason(file: CommitFile, changedLines: number | null, generatedPaths: ReadonlySet<string> = new Set()): string | null {
  const path = file.path;
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (file.binary) return 'binary file';
  if (file.status === 'deleted') return 'deleted file';
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|tiff?|pdf|woff2?|ttf|eot|otf|zip|gz|tgz|jar|exe|dll|so|dylib|mp[34]|mov|wasm)$/i.test(base)) return 'binary or media file';
  if (LOCKFILES.has(base)) return 'lockfile';
  if (/\.min\.(js|css|mjs)$/i.test(base) || /\.(js|css)\.map$/i.test(base)) return 'minified or generated asset';
  if (generatedPaths.has(path)) return 'marked linguist-generated';
  for (const dir of GENERATED_DIRS) if (path.startsWith(dir) || path.includes(`/${dir}`)) return 'build output or vendored code';
  if (changedLines !== null && changedLines > MAX_CHANGED_LINES_PER_FILE) return `too large (${changedLines.toLocaleString()} changed lines)`;
  return null;
}

export function changedLineCount(hunks: DiffHunk[]): number {
  let n = 0;
  for (const h of hunks) for (const l of h.lines) if (l.type === 'add' || l.type === 'delete') n++;
  return n;
}

/**
 * Renders hunks as text the model can cite: every new-side line is prefixed
 * with `[new:N]`, deleted lines with `[del]`, so the model never has to count.
 */
export function annotateHunks(hunks: DiffHunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(h.header || `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.type === 'hunk') continue;
      const text = l.text.replace(/\r$/, '');
      if (l.type === 'delete') out.push(`[del]     -${text}`);
      else if (l.type === 'add') out.push(`[new:${String(l.newLineNumber ?? '').padStart(4)}] +${text}`);
      else out.push(`[new:${String(l.newLineNumber ?? '').padStart(4)}]  ${text}`);
      if (l.noNewline) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n');
}

export interface NewSideIndex {
  /** New-side line numbers present in the diff (add + context). */
  lines: Set<number>;
  /** Line number -> hunk index, to enforce same-hunk ranges. */
  hunkOf: Map<number, number>;
}

export function indexNewSide(hunks: DiffHunk[]): NewSideIndex {
  const lines = new Set<number>();
  const hunkOf = new Map<number, number>();
  hunks.forEach((h, hi) => {
    for (const l of h.lines) {
      if (l.newLineNumber !== null && (l.type === 'add' || l.type === 'context')) {
        lines.add(l.newLineNumber);
        hunkOf.set(l.newLineNumber, hi);
      }
    }
  });
  return { lines, hunkOf };
}

/** Maps a cited line onto the diff: exact when present, else the nearest following new-side line within REMAP_DISTANCE. */
export function remapLine(line: number, index: NewSideIndex): number | null {
  if (index.lines.has(line)) return line;
  for (let d = 1; d <= REMAP_DISTANCE; d++) if (index.lines.has(line + d)) return line + d;
  return null;
}

export function stripFences(text: string): string {
  let t = text.replace(/\r\n/g, '\n');
  const fence = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (fence) t = fence[1];
  t = t.replace(/^```[^\n]*\n?/gm, '').replace(/\n?```\s*$/gm, '');
  return t.replace(/\n+$/, '');
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(text);
}

export interface RawFinding {
  line?: unknown;
  endLine?: unknown;
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  detail?: unknown;
  suggestion?: unknown;
  confidence?: unknown;
}

export interface ValidationResult {
  findings: ReviewFinding[];
  dropped: number;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

/**
 * Validates raw model findings for one file against its hunks, applying the
 * rules from the spec: lines must exist on the new side (deleted-line
 * citations are remapped within REMAP_DISTANCE), ranges stay inside one hunk,
 * text limits, fence stripping, duplicate merging and strict-mode confidence.
 */
export function validateFindings(raw: unknown, path: string, hunks: DiffHunk[], strictness: ReviewStrictness): ValidationResult {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { findings?: unknown }).findings) ? ((raw as { findings: unknown[] }).findings as RawFinding[]) : Array.isArray(raw) ? (raw as RawFinding[]) : [];
  const index = indexNewSide(hunks);
  let dropped = 0;
  const accepted: ReviewFinding[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') {
      dropped++;
      continue;
    }
    const cited = asInt(f.line);
    const title = typeof f.title === 'string' ? f.title.trim().replace(/\s+/g, ' ') : '';
    const detail = typeof f.detail === 'string' ? f.detail.trim() : '';
    const severity = SEVERITIES.includes(f.severity as ReviewSeverity) ? (f.severity as ReviewSeverity) : null;
    const category = CATEGORIES.includes(f.category as ReviewCategory) ? (f.category as ReviewCategory) : 'readability';
    const confidence = f.confidence === 'high' || f.confidence === 'medium' || f.confidence === 'low' ? f.confidence : 'medium';
    if (cited === null || !title || title.length > MAX_TITLE_CHARS || detail.length > MAX_DETAIL_CHARS || !severity) {
      dropped++;
      continue;
    }
    const line = remapLine(cited, index);
    if (line === null) {
      dropped++;
      continue;
    }
    let endLine: number | null = null;
    const citedEnd = asInt(f.endLine);
    if (citedEnd !== null && citedEnd !== cited) {
      const shifted = citedEnd + (line - cited);
      const mapped = remapLine(shifted, index);
      if (mapped === null || mapped < line || index.hunkOf.get(mapped) !== index.hunkOf.get(line)) {
        dropped++;
        continue;
      }
      endLine = mapped;
    }
    let suggestion: string | null = null;
    if (typeof f.suggestion === 'string' && f.suggestion.trim()) {
      suggestion = stripFences(f.suggestion);
      if (hasConflictMarkers(suggestion)) {
        dropped++;
        continue;
      }
      if (endLine === null) endLine = line;
    }
    if (strictness === 'strict' && confidence === 'low') {
      dropped++;
      continue;
    }
    accepted.push({ id: findingId(path, line, title), path, line, endLine, severity, category, title, detail, suggestion, confidence, dismissed: false });
  }
  return { findings: mergeDuplicates(accepted), dropped };
}

/** Merges findings with the same path, line and normalized title, keeping the higher severity and confidence. */
export function mergeDuplicates(findings: ReviewFinding[]): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding>();
  for (const f of findings) {
    const key = `${f.path}\0${f.line}\0${normalizeTitle(f.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      continue;
    }
    const higherSeverity = SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity];
    const merged: ReviewFinding = {
      ...existing,
      severity: higherSeverity ? f.severity : existing.severity,
      confidence: rankConfidence(f.confidence) > rankConfidence(existing.confidence) ? f.confidence : existing.confidence,
      detail: existing.detail.length >= f.detail.length ? existing.detail : f.detail,
      suggestion: existing.suggestion ?? f.suggestion,
      endLine: existing.endLine ?? f.endLine,
    };
    byKey.set(key, merged);
  }
  return [...byKey.values()].sort(compareFindings);
}

function rankConfidence(c: ReviewFinding['confidence']): number {
  return c === 'high' ? 2 : c === 'medium' ? 1 : 0;
}

export function compareFindings(a: ReviewFinding, b: ReviewFinding): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  const p = a.path.localeCompare(b.path);
  if (p !== 0) return p;
  return a.line - b.line;
}

/** Verdict the code suggests from the surviving findings; the model's verdict may only be stricter than this floor. */
export function verdictFloor(findings: ReviewFinding[]): 'approve' | 'comment' | 'request-changes' {
  const live = findings.filter((f) => !f.dismissed);
  if (live.some((f) => f.severity === 'blocker')) return 'request-changes';
  if (live.some((f) => f.severity === 'warning')) return 'comment';
  return 'approve';
}

export interface ReviewCommentPayload {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  body: string;
  comments: ReviewCommentPayload[];
}

export const AI_FOOTER = (login: string | null): string => `_Drafted with AI in GitGood; reviewed by ${login ? `@${login}` : 'the author'}._`;

export function formatFindingComment(f: ReviewFinding): string {
  const parts = [`**${f.title}**`, f.detail].filter(Boolean);
  if (f.suggestion !== null) parts.push('```suggestion\n' + f.suggestion + '\n```');
  parts.push(`<sub>${f.severity} · ${f.category} · ${f.confidence} confidence</sub>`);
  return parts.join('\n\n');
}

/** Builds the REST payload for POST /repos/{o}/{r}/pulls/{n}/reviews. */
export function buildReviewPayload(opts: { commitId: string; event: ReviewPayload['event']; body: string; findings: ReviewFinding[]; footer: string | null }): ReviewPayload {
  const comments: ReviewCommentPayload[] = opts.findings.map((f) => {
    const c: ReviewCommentPayload = { path: f.path, line: f.endLine ?? f.line, side: 'RIGHT', body: formatFindingComment(f) };
    if (f.endLine !== null && f.endLine > f.line) {
      c.start_line = f.line;
      c.start_side = 'RIGHT';
    }
    return c;
  });
  let body = opts.body.trim();
  if (opts.footer) body = body ? `${body}\n\n${opts.footer}` : opts.footer;
  return { commit_id: opts.commitId, event: opts.event, body, comments };
}

/** Fallback used after a 422: inline comments become a list in the review body. */
export function foldCommentsIntoBody(payload: ReviewPayload): ReviewPayload {
  if (!payload.comments.length) return payload;
  const list = payload.comments.map((c) => `- \`${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}\` — ${c.body.split('\n')[0].replace(/^\*\*|\*\*$/g, '')}`).join('\n');
  const body = payload.body ? `${payload.body}\n\n**Findings**\n${list}` : `**Findings**\n${list}`;
  return { ...payload, body, comments: [] };
}

// ---------------------------------------------------------------------------
// Pre-commit review: applying a suggestion to the working tree
// ---------------------------------------------------------------------------

/**
 * Replaces 1-based lines [startLine, endLine] of `content` with `suggestion`,
 * preserving the file's own line ending (`\n` or `\r\n`) and whether it ends
 * with a trailing newline. `suggestion` is split on either ending and
 * rejoined with the file's own, so a suggestion produced against an LF file
 * can still be applied to a CRLF one.
 */
export function replaceLinesInContent(content: string, startLine: number, endLine: number, suggestion: string): string {
  const { lines, eol, trailingNewline } = splitLines(content);
  const suggestionLines = suggestion.length ? suggestion.split(/\r?\n/) : [];
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  const next = [...lines.slice(0, start), ...suggestionLines, ...lines.slice(end)];
  return joinLines(next, eol, trailingNewline);
}

// ---------------------------------------------------------------------------
// Pre-commit review: nearby test files hint
// ---------------------------------------------------------------------------

/**
 * Filters a repository's test-looking paths (from `git ls-files`) down to
 * ones that share a directory with a changed file, capped at `cap` entries
 * so the prompt never grows unbounded on a huge repository.
 */
export function filterNearbyTestPaths(allTestPaths: string[], changedPaths: string[], cap = 200): string[] {
  const dirs = new Set(changedPaths.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));
  const out: string[] = [];
  for (const p of allTestPaths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dirs.has(dir)) out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

/** Extracts `#123` / `owner/repo#123` issue references from a PR body. */
export function linkedIssueNumbers(body: string, max = 3): number[] {
  const seen = new Set<number>();
  const re = /(?:^|[\s(])(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+)?#(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) && seen.size < max) seen.add(parseInt(m[1], 10));
  return [...seen];
}
