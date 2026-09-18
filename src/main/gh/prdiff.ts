import type { CommitFile, FileStatusKind } from '@shared/types';
import { parseUnifiedDiff, unquote, type ParsedDiff } from '@shared/diff/parse';

/** Paths from a `diff --git a/x b/y` line; the only place binary diffs name their files. */
export function pathsFromDiffHeader(line: string): { oldPath: string; newPath: string } | null {
  const m = /^diff --git (?:"(a\/(?:[^"\\]|\\.)*)"|(a\/\S.*?)) (?:"(b\/(?:[^"\\]|\\.)*)"|(b\/.*))$/.exec(line);
  if (!m) return null;
  const a = m[1] ? unquote(`"${m[1]}"`) : m[2];
  const b = m[3] ? unquote(`"${m[3]}"`) : m[4];
  if (!a || !b) return null;
  return { oldPath: a.slice(2), newPath: b.slice(2) };
}

export interface SplitPrDiff {
  files: CommitFile[];
  /** Parsed diff per new-side path (old path for deletions). */
  diffs: Map<string, ParsedDiff>;
}

/**
 * Splits the unified diff printed by `gh pr diff` (or `git diff base...head`)
 * into per-file entries with additions/deletions, plus the parsed hunks for
 * each file so the review does not have to re-parse the text.
 */
export function splitPrDiff(text: string): SplitPrDiff {
  const files: CommitFile[] = [];
  const diffs = new Map<string, ParsedDiff>();
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const parsed = parseUnifiedDiff(chunk);
    const h = parsed.header;
    const fromHeader = pathsFromDiffHeader(chunk.split('\n', 1)[0]);
    if (fromHeader) {
      if (h.isBinary || (!h.oldPath && !h.newPath && !h.isNew && !h.isDeleted)) {
        h.oldPath ??= fromHeader.oldPath;
        h.newPath ??= fromHeader.newPath;
      }
    }
    const path = h.newPath ?? h.oldPath;
    if (!path) continue;
    let status: FileStatusKind = 'modified';
    if (h.isNew) status = 'new';
    else if (h.isDeleted) status = 'deleted';
    else if (h.isRename) status = 'renamed';
    else if (h.isCopy) status = 'copied';
    else if (h.oldMode && h.newMode && parsed.hunks.length === 0) status = 'typechange';
    let additions = 0;
    let deletions = 0;
    for (const hunk of parsed.hunks) for (const l of hunk.lines) l.type === 'add' ? additions++ : l.type === 'delete' ? deletions++ : 0;
    files.push({
      path,
      oldPath: h.isRename || h.isCopy ? h.oldPath : null,
      status,
      additions: h.isBinary ? null : additions,
      deletions: h.isBinary ? null : deletions,
      binary: h.isBinary,
      lfs: false,
    });
    diffs.set(path, parsed);
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return { files, diffs };
}
