/**
 * Pure helpers for AI release notes: PR-number extraction from merge/squash
 * commit subjects, reference validation against the real commit/PR range,
 * fixed-order section assembly, Markdown rendering, changelog insertion and
 * a semver next-patch suggestion. No Electron or Node imports so this can be
 * unit tested and reasoned about in isolation (mirrors review-core.ts).
 */
import type { ReleaseCommit, ReleaseNotes, ReleaseNotesSection, ReleaseNotesUnreferencedEntry } from '@shared/types';
import { joinLines, splitLines } from '@shared/util';

/** Bullet items are capped at this many characters (spec: "cap items at 200 characters"). */
export const MAX_ITEM_CHARS = 200;
/** Ranges with more non-merge commits than this fall back to subjects-only gathering (spec: "Ranges over 500 commits"). */
export const MAX_RANGE_COMMITS = 500;

/** Fixed section order the model's output is normalized into; any other title is dropped. */
export const SECTION_ORDER = ['Breaking changes', 'Features', 'Fixes', 'Performance', 'Docs', 'Internal'] as const;
export type SectionTitle = (typeof SECTION_ORDER)[number];
export const MAX_SECTIONS = SECTION_ORDER.length;
const SECTION_SET: ReadonlySet<string> = new Set(SECTION_ORDER);

// ---------------------------------------------------------------------------
// PR number extraction
// ---------------------------------------------------------------------------

/** PR number from a merge-commit subject ("Merge pull request #123 from owner/branch"), or null. */
export function extractMergePrNumber(subject: string): number | null {
  const m = /^Merge pull request #(\d+)\b/.exec(subject.trim());
  return m ? parseInt(m[1], 10) : null;
}

/** PR number from a squash-merge commit subject ending "(#123)", or null. */
export function extractSquashPrNumber(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject.trim());
  return m ? parseInt(m[1], 10) : null;
}

/** Every PR number referenced by merge-commit subjects or squash-merge commit subjects in a range, each counted once, ascending. */
export function collectPrNumbers(mergeSubjects: string[], nonMergeSubjects: string[]): number[] {
  const seen = new Set<number>();
  for (const s of mergeSubjects) {
    const n = extractMergePrNumber(s);
    if (n !== null) seen.add(n);
  }
  for (const s of nonMergeSubjects) {
    const n = extractSquashPrNumber(s);
    if (n !== null) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Reference validation and section assembly
// ---------------------------------------------------------------------------

/** A ref cited by a raw model item, resolved against the range, or null when it is not a PR number/SHA prefix found in the range. Canonical form: "#123" for a PR, the commit's own short SHA for a commit. */
function resolveRef(raw: unknown, prNumbers: ReadonlySet<number>, commits: readonly ReleaseCommit[]): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^#?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed.replace(/^#/, ''), 10);
    return prNumbers.has(n) ? `#${n}` : null;
  }
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    const match = commits.find((c) => c.sha.toLowerCase().startsWith(lower));
    return match ? match.shortSha : null;
  }
  return null;
}

export interface ReleaseNotesContext {
  version: string;
  /** YYYY-MM-DD, used in the heading. */
  date: string;
  /** Non-merge commits in the range (see MAX_RANGE_COMMITS / truncated). */
  commits: ReleaseCommit[];
  /** Every PR number found in the range (merge + squash subjects), unique. */
  prNumbers: number[];
  /** Title for PR numbers that could be fetched (capped, best-effort; missing entries render as a bare "#N"). */
  prTitles: Map<number, string>;
  truncated: boolean;
  model: string;
}

/** One "citable unit" a release-notes item can reference: a PR (when a commit's subject cites one, or a merge subject does) or a standalone commit. Each PR appears once even when several commits reference it. */
function citableUnits(ctx: Pick<ReleaseNotesContext, 'commits' | 'prNumbers' | 'prTitles'>): { ref: string; label: string }[] {
  const prSeen = new Set<number>();
  const out: { ref: string; label: string }[] = [];
  const labelForPr = (n: number): string => {
    const title = ctx.prTitles.get(n);
    return title ? `${title} (#${n})` : `#${n}`;
  };
  for (const c of ctx.commits) {
    if (c.prNumber !== null) {
      if (prSeen.has(c.prNumber)) continue;
      prSeen.add(c.prNumber);
      out.push({ ref: `#${c.prNumber}`, label: labelForPr(c.prNumber) });
      continue;
    }
    out.push({ ref: c.shortSha, label: `${c.subject} (${c.shortSha})` });
  }
  for (const n of ctx.prNumbers) {
    if (prSeen.has(n)) continue;
    prSeen.add(n);
    out.push({ ref: `#${n}`, label: labelForPr(n) });
  }
  return out;
}

/**
 * Validates the model's raw sections/items against the real range: unknown
 * section titles are dropped, unknown refs are removed from an item (keeping
 * any valid ones), items left with zero refs are moved to `unreferenced`
 * instead of a section, duplicate sections are merged, items are capped at
 * MAX_ITEM_CHARS, sections render in the fixed order, and every commit/PR in
 * range that no surviving item cites is appended to `unreferenced`. The
 * Markdown is then assembled by GitGood; the model never emits it directly.
 */
export function buildReleaseNotes(raw: unknown, ctx: ReleaseNotesContext): ReleaseNotes {
  const prNumberSet = new Set(ctx.prNumbers);
  const rawSections = raw && typeof raw === 'object' && Array.isArray((raw as { sections?: unknown }).sections) ? ((raw as { sections: unknown[] }).sections as unknown[]) : [];

  const byTitle = new Map<SectionTitle, { text: string; refs: string[] }[]>();
  const unreferenced: ReleaseNotesUnreferencedEntry[] = [];
  const citedRefs = new Set<string>();

  for (const rawSection of rawSections) {
    if (!rawSection || typeof rawSection !== 'object') continue;
    const title = (rawSection as { title?: unknown }).title;
    if (typeof title !== 'string' || !SECTION_SET.has(title)) continue;
    const items = Array.isArray((rawSection as { items?: unknown }).items) ? ((rawSection as { items: unknown[] }).items as unknown[]) : [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const rawText = (rawItem as { text?: unknown }).text;
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text) continue;
      const rawRefs = Array.isArray((rawItem as { refs?: unknown }).refs) ? ((rawItem as { refs: unknown[] }).refs as unknown[]) : [];
      const refs: string[] = [];
      for (const r of rawRefs) {
        const resolved = resolveRef(r, prNumberSet, ctx.commits);
        if (resolved && !refs.includes(resolved)) refs.push(resolved);
      }
      const capped = text.length > MAX_ITEM_CHARS ? text.slice(0, MAX_ITEM_CHARS) : text;
      if (!refs.length) {
        unreferenced.push({ text: capped, ref: null });
        continue;
      }
      for (const r of refs) citedRefs.add(r);
      const list = byTitle.get(title as SectionTitle) ?? [];
      list.push({ text: capped, refs });
      byTitle.set(title as SectionTitle, list);
    }
  }

  const sections: ReleaseNotesSection[] = SECTION_ORDER.filter((t) => byTitle.has(t))
    .slice(0, MAX_SECTIONS)
    .map((title) => ({ title, items: byTitle.get(title)! }));

  for (const unit of citableUnits(ctx)) {
    if (!citedRefs.has(unit.ref)) unreferenced.push({ text: unit.label, ref: unit.ref });
  }

  const markdown = renderReleaseNotesMarkdown(ctx.version, ctx.date, sections);
  return { version: ctx.version, markdown, sections, unreferenced, truncated: ctx.truncated, model: ctx.model };
}

// ---------------------------------------------------------------------------
// Markdown assembly
// ---------------------------------------------------------------------------

/** `## <version> (<date>)`, `### <section>`, `- text (refs)` — GitGood owns this structure; the model never emits it. */
export function renderReleaseNotesMarkdown(version: string, date: string, sections: ReleaseNotesSection[]): string {
  const heading = `## ${version.trim() || 'Unreleased'} (${date})`;
  const parts = [heading];
  for (const section of sections) {
    if (!section.items.length) continue;
    const lines = section.items.map((item) => `- ${item.text} (${item.refs.join(', ')})`);
    parts.push(`### ${section.title}\n\n${lines.join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Changelog insertion
// ---------------------------------------------------------------------------

const TOP_HEADING_RE = /^#\s+\S/;

/**
 * Inserts `sectionMarkdown` (a rendered release-notes Markdown block) under
 * CHANGELOG.md's first `# ` heading, or creates the file with a `# Changelog`
 * heading when `existing` is null (file absent) or has no such heading. Line
 * endings and the file's trailing-newline state are preserved via
 * splitLines/joinLines from shared/util.
 */
export function insertIntoChangelog(existing: string | null, sectionMarkdown: string): { content: string; created: boolean } {
  const newLines = sectionMarkdown.trim().split(/\r\n|\n/);
  if (existing === null) {
    return { content: `# Changelog\n\n${newLines.join('\n')}\n`, created: true };
  }
  const { lines, eol } = splitLines(existing);
  const headingIdx = lines.findIndex((l) => TOP_HEADING_RE.test(l));
  let result: string[];
  if (headingIdx === -1) {
    result = ['# Changelog', '', ...newLines, '', ...lines];
  } else {
    const before = lines.slice(0, headingIdx + 1);
    let after = lines.slice(headingIdx + 1);
    if (after[0] === '') after = after.slice(1);
    result = [...before, '', ...newLines, '', ...after];
  }
  // Trim a run of blank lines the splice above may have left at the very end.
  while (result.length > 1 && result[result.length - 1] === '' && result[result.length - 2] === '') result.pop();
  // Always end the rewritten file with a trailing newline, regardless of whether the original did.
  return { content: joinLines(result, eol, true), created: false };
}

// ---------------------------------------------------------------------------
// Semver next-patch suggestion
// ---------------------------------------------------------------------------

export { suggestNextPatchVersion } from '@shared/util';
