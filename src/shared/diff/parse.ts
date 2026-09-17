import type { DiffHunk, DiffLine } from '../types';

export interface ParsedDiffHeader {
  oldPath: string | null;
  newPath: string | null;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isCopy: boolean;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  /** Submodule "Subproject commit" summary lines, when applicable. */
  subproject: { oldSha: string | null; newSha: string | null } | null;
}

export interface ParsedDiff {
  header: ParsedDiffHeader;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function emptyHeader(): ParsedDiffHeader {
  return {
    oldPath: null,
    newPath: null,
    isBinary: false,
    isNew: false,
    isDeleted: false,
    isRename: false,
    isCopy: false,
    oldMode: null,
    newMode: null,
    similarity: null,
    subproject: null,
  };
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string | null {
  if (p === '/dev/null') return null;
  let out = p;
  if (out.startsWith('"') && out.endsWith('"')) out = unquote(out);
  if (out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

/** Undo git's C-style path quoting (used when core.quotePath is on). */
export function unquote(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      bytes.push(...Array.from(new TextEncoder().encode(ch)));
      continue;
    }
    const next = inner[i + 1];
    if (/[0-7]/.test(next) && /[0-7]/.test(inner[i + 2] ?? '') && /[0-7]/.test(inner[i + 3] ?? '')) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const map: Record<string, number> = { n: 10, t: 9, r: 13, '\\': 92, '"': 34, a: 7, b: 8, f: 12, v: 11 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Parses `git diff` output. Handles one or more file sections and returns them
 * in order; most callers only diff a single path and use parseUnifiedDiff.
 */
export function parseUnifiedDiffs(text: string): ParsedDiff[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const results: ParsedDiff[] = [];
  let current: ParsedDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;
  let lastLine: DiffLine | null = null;

  const startFile = () => {
    current = { header: emptyHeader(), hunks: [] };
    results.push(current);
    hunk = null;
    lastLine = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line: string = raw.endsWith('\r') && !hunk ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git ')) {
      startFile();
      const m = /^diff --git (?:"?a\/.*?"?) (?:"?b\/.*?"?)$/.exec(line);
      void m;
      continue;
    }

    if (!current) {
      // Tolerate diffs that begin directly with ---/+++ (e.g. synthesized).
      if (line.startsWith('--- ') || line.startsWith('@@')) startFile();
      else continue;
    }
    const cur: ParsedDiff = current!;

    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = line[0];
      if (marker === '\\') {
        if (lastLine) lastLine.noNewline = true;
        continue;
      }
      let type: DiffLine['type'];
      let text: string;
      if (marker === '+') {
        type = 'add';
        text = line.slice(1);
      } else if (marker === '-') {
        type = 'delete';
        text = line.slice(1);
      } else if (marker === ' ') {
        type = 'context';
        text = line.slice(1);
      } else if (line === '' || line === '\r') {
        // Some tools strip the leading space from blank context lines.
        type = 'context';
        text = '';
      } else {
        // Malformed; bail out of the hunk.
        oldRemaining = 0;
        newRemaining = 0;
        hunk = null;
        i--;
        continue;
      }
      const dl: DiffLine = {
        type,
        text: text.endsWith('\r') ? text.slice(0, -1) : text,
        oldLineNumber: type === 'add' ? null : oldLine,
        newLineNumber: type === 'delete' ? null : newLine,
        noNewline: false,
      };
      if (type !== 'add') {
        oldLine++;
        oldRemaining--;
      }
      if (type !== 'delete') {
        newLine++;
        newRemaining--;
      }
      hunk.lines.push(dl);
      lastLine = dl;
      continue;
    }

    if (line.startsWith('\\') && lastLine) {
      lastLine.noNewline = true;
      continue;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      const oldStart = parseInt(hm[1], 10);
      const oldLines = hm[2] === undefined ? 1 : parseInt(hm[2], 10);
      const newStart = parseInt(hm[3], 10);
      const newLines = hm[4] === undefined ? 1 : parseInt(hm[4], 10);
      hunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      cur.hunks.push(hunk);
      oldRemaining = oldLines;
      newRemaining = newLines;
      oldLine = oldStart;
      newLine = newStart;
      lastLine = null;
      continue;
    }

    const h = cur.header;
    if (line.startsWith('--- ')) {
      h.oldPath = stripPrefix(line.slice(4), 'a/');
      if (h.oldPath === null) h.isNew = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      h.newPath = stripPrefix(line.slice(4), 'b/');
      if (h.newPath === null) h.isDeleted = true;
      continue;
    }
    if (line.startsWith('old mode ')) {
      h.oldMode = line.slice(9).trim();
      continue;
    }
    if (line.startsWith('new mode ')) {
      h.newMode = line.slice(9).trim();
      continue;
    }
    if (line.startsWith('new file mode ')) {
      h.isNew = true;
      h.newMode = line.slice(14).trim();
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      h.isDeleted = true;
      h.oldMode = line.slice(18).trim();
      continue;
    }
    if (line.startsWith('similarity index ')) {
      h.similarity = parseInt(line.slice(17), 10);
      continue;
    }
    if (line.startsWith('rename from ')) {
      h.isRename = true;
      h.oldPath = line.slice(12);
      continue;
    }
    if (line.startsWith('rename to ')) {
      h.isRename = true;
      h.newPath = line.slice(10);
      continue;
    }
    if (line.startsWith('copy from ')) {
      h.isCopy = true;
      h.oldPath = line.slice(10);
      continue;
    }
    if (line.startsWith('copy to ')) {
      h.isCopy = true;
      h.newPath = line.slice(8);
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      h.isBinary = true;
      continue;
    }
    if (line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('-Subproject commit ') || line.startsWith('+Subproject commit ')) {
      h.subproject ??= { oldSha: null, newSha: null };
      const sha = line.slice('+Subproject commit '.length).replace(/-dirty$/, '').trim();
      if (line[0] === '-') h.subproject.oldSha = sha;
      else h.subproject.newSha = sha;
      continue;
    }
  }
  return results;
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const all = parseUnifiedDiffs(text);
  return all[0] ?? { header: emptyHeader(), hunks: [] };
}

/** Total number of add/delete/context lines across hunks. */
export function countDiffLines(hunks: DiffHunk[]): { total: number; additions: number; deletions: number } {
  let total = 0;
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      total++;
      if (l.type === 'add') additions++;
      else if (l.type === 'delete') deletions++;
    }
  }
  return { total, additions, deletions };
}

/**
 * Synthesizes an "everything added" diff for an untracked file so that new
 * files render the same way as tracked ones.
 */
export function synthesizeAddedDiff(path: string, content: string): ParsedDiff {
  const rawLines = content === '' ? [] : content.split('\n');
  const trailingNewline = content.endsWith('\n');
  if (trailingNewline) rawLines.pop();
  const lines: DiffLine[] = rawLines.map((text, i) => ({
    type: 'add',
    text: text.endsWith('\r') ? text.slice(0, -1) : text,
    oldLineNumber: null,
    newLineNumber: i + 1,
    noNewline: false,
  }));
  if (lines.length && !trailingNewline) lines[lines.length - 1].noNewline = true;
  const header = emptyHeader();
  header.isNew = true;
  header.newPath = path;
  header.newMode = '100644';
  if (lines.length === 0) return { header, hunks: [] };
  return {
    header,
    hunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines,
      },
    ],
  };
}
