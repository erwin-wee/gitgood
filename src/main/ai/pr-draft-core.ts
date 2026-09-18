/**
 * Pure helpers for the AI pull request draft: issue reference extraction
 * from commit messages, template heading extraction and post-hoc integrity
 * restoration, checkbox restoration, title normalization and issue-link
 * reconciliation. No Electron or Node imports so this can be unit tested and
 * reasoned about in isolation (mirrors the pattern in ./review-core.ts).
 */

export const MAX_BODY_CHARS = 60_000;

const CLOSING_KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const HEADING_RE = /^#{1,6}\s+\S/;
const CHECKBOX_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*)(.*)$/;

// ---------------------------------------------------------------------------
// Issue reference extraction
// ---------------------------------------------------------------------------

export interface RawIssueMention {
  number: number;
  /** "owner/repo" when the mention was qualified, null for a bare `#N`. */
  repo: string | null;
  closing: boolean;
}

/** Removes fenced and inline code spans so a `#123` inside a code sample is never mistaken for an issue reference. */
export function stripCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Extracts `#N`, `Fixes #N` / `Closes #N` / `Resolves #N` (and their
 * inflections) and `owner/repo#N` references from one piece of text,
 * ignoring anything inside inline or fenced code spans.
 */
export function extractIssueMentions(text: string): RawIssueMention[] {
  const cleaned = stripCodeSpans(text);
  // The negative lookbehind keeps a bare `#N` from matching mid-word (e.g. "abc#17"), while still
  // allowing it right after whitespace/punctuation with nothing captured by the optional groups.
  const re = new RegExp(`(?<![\\w/.-])(?:(${CLOSING_KEYWORD})\\s*:?\\s+)?([A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+)?#(\\d+)\\b`, 'gi');
  const out: RawIssueMention[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    out.push({ number: parseInt(m[3], 10), repo: m[2] ?? null, closing: !!m[1] });
  }
  return out;
}

export interface IssueRef {
  number: number;
  /** True when at least one commit referenced this issue with a closing keyword. */
  closing: boolean;
}

/**
 * Collects every issue number mentioned across a branch's commit messages
 * (closing when any commit used a closing keyword for it) plus, for numbers
 * not already present, any mentioned in the existing PR body (never as
 * closing — closing keywords only ever come from commit messages). Ignores
 * the repo qualifier of `owner/repo#N`: GitGood only links issues in the
 * current repository.
 */
export function collectIssueReferences(commitMessages: string[], existingBody = ''): IssueRef[] {
  const closingByNumber = new Map<number, boolean>();
  for (const message of commitMessages) {
    for (const mention of extractIssueMentions(message)) {
      closingByNumber.set(mention.number, (closingByNumber.get(mention.number) ?? false) || mention.closing);
    }
  }
  for (const mention of extractIssueMentions(existingBody)) {
    if (!closingByNumber.has(mention.number)) closingByNumber.set(mention.number, false);
  }
  return [...closingByNumber.entries()].map(([number, closing]) => ({ number, closing })).sort((a, b) => a.number - b.number);
}

export interface DraftLinkedIssue {
  number: number;
  keyword: 'closes' | 'refs';
}

/**
 * Intersects the model's proposed `linkedIssues` with the issue numbers
 * actually found in the commits/body (`valid`), dropping anything the model
 * invented, and downgrades `closes` to `refs` when no commit used a closing
 * keyword for that issue.
 */
export function reconcileLinkedIssues(modelIssues: unknown, valid: IssueRef[]): DraftLinkedIssue[] {
  const closingAllowed = new Map(valid.map((r) => [r.number, r.closing]));
  const list = Array.isArray(modelIssues) ? modelIssues : [];
  const seen = new Set<number>();
  const out: DraftLinkedIssue[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const number = (raw as { number?: unknown }).number;
    if (typeof number !== 'number' || !Number.isInteger(number) || seen.has(number) || !closingAllowed.has(number)) continue;
    seen.add(number);
    const keyword = (raw as { keyword?: unknown }).keyword;
    out.push({ number, keyword: keyword === 'closes' && closingAllowed.get(number) ? 'closes' : 'refs' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template headings
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * GitHub closes an issue for any `Fixes #N`-style keyword in the PR body, so the model must not
 * be able to invent one: closing keywords are kept only for issues that a commit message itself
 * closed; every other `<keyword> #N` (or `owner/repo#N`) is rewritten to `Refs #N`. Plain `#N`
 * mentions are left alone. Code spans are not touched.
 */
export function downgradeUnallowedClosings(body: string, valid: IssueRef[]): string {
  const allowed = new Set(valid.filter((r) => r.closing).map((r) => r.number));
  const re = new RegExp(`(^|[^\\w/.-])(${CLOSING_KEYWORD})(\\s*:?\\s+)((?:[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+)?#(\\d+))\\b`, 'gi');
  // Protect code spans so keywords inside them are not rewritten.
  const spans: string[] = [];
  const protectedBody = body.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    spans.push(m);
    return `\u0000${spans.length - 1}\u0000`;
  });
  const rewritten = protectedBody.replace(re, (whole, lead: string, keyword: string, sep: string, ref: string, num: string) => {
    if (allowed.has(parseInt(num, 10))) return whole;
    const refs = /^[A-Z]/.test(keyword) ? 'Refs' : 'refs';
    return `${lead}${refs}${sep}${ref}`;
  });
  return rewritten.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[parseInt(i, 10)]);
}

export function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Heading lines (`#` through `######`), trimmed, in document order. */
export function extractTemplateHeadings(template: string): string[] {
  return splitLines(template)
    .map((l) => l.trim())
    .filter((l) => HEADING_RE.test(l));
}

/** True when every heading appears in `body` as its own (trimmed) line, in the same relative order (not necessarily contiguous). */
export function headingsPresentInOrder(body: string, headings: string[]): boolean {
  if (!headings.length) return true;
  const lines = splitLines(body).map((l) => l.trim());
  let i = 0;
  for (const line of lines) {
    if (line === headings[i]) {
      i++;
      if (i === headings.length) return true;
    }
  }
  return false;
}

/**
 * Rebuilds a body that failed `headingsPresentInOrder`: the model's
 * paragraphs are placed under the template's first heading, and the rest of
 * the template follows verbatim, preserving the template's own line ending.
 */
export function restoreTemplateStructure(modelBody: string, template: string): string {
  const eol = detectLineEnding(template);
  const lines = splitLines(template);
  const firstHeadingIdx = lines.findIndex((l) => HEADING_RE.test(l.trim()));
  const cleanedModel = modelBody.trim().replace(/\r\n|\r|\n/g, eol);
  if (firstHeadingIdx === -1) return [cleanedModel, template.trim()].filter(Boolean).join(eol + eol);
  const before = lines.slice(0, firstHeadingIdx + 1);
  const after = lines.slice(firstHeadingIdx + 1);
  return [...before, '', cleanedModel, '', ...after].join(eol);
}

// ---------------------------------------------------------------------------
// Checkbox restoration
// ---------------------------------------------------------------------------

/** Normalized (trimmed, lower-cased) label text of every checkbox line in the template. */
export function templateCheckboxLabels(template: string): Set<string> {
  const labels = new Set<string>();
  for (const line of splitLines(template)) {
    const m = CHECKBOX_RE.exec(line);
    if (m) labels.add(m[4].trim().toLowerCase());
  }
  return labels;
}

/**
 * Forces every checkbox line in `body` whose label matches one of the
 * template's checkboxes back to unchecked, unless its label text mentions
 * one of `changedPaths` (or a path's basename) — the model has no reliable
 * way to verify a checklist item, so a tick is only trusted when it is
 * obviously grounded in the diff. Checkbox lines the model added that are
 * not in the template are left alone.
 */
export function restoreCheckboxes(body: string, templateLabels: ReadonlySet<string>, changedPaths: string[]): string {
  if (!templateLabels.size) return body;
  const eol = detectLineEnding(body);
  const haystacks = changedPaths.flatMap((p) => [p.toLowerCase(), (p.split('/').pop() ?? '').toLowerCase()]).filter(Boolean);
  return splitLines(body)
    .map((line) => {
      const m = CHECKBOX_RE.exec(line);
      if (!m) return line;
      const label = m[4].trim().toLowerCase();
      if (!templateLabels.has(label)) return line;
      const satisfied = haystacks.some((h) => label.includes(h));
      return `${m[1]}${satisfied ? 'x' : ' '}${m[3]}${m[4]}`;
    })
    .join(eol);
}

// ---------------------------------------------------------------------------
// Title normalization, body cap and the create-time footer
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 256;

/** Single line, no trailing period(s), truncated to at most `maxChars` (256 by default; never more, per spec). */
export function normalizePrTitle(raw: string, maxChars = MAX_TITLE_CHARS): string {
  const firstLine = (raw.split(/\r?\n/)[0] ?? '').trim();
  let title = firstLine.replace(/\.+$/, '').trim();
  if (title.length > maxChars) title = title.slice(0, maxChars).trimEnd();
  return title;
}

export function capBody(body: string, max = MAX_BODY_CHARS): string {
  return body.length > max ? body.slice(0, max) : body;
}
