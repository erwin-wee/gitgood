import type { DiffHunk } from '../types';

export interface PatchSource {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  /** Mode for new files; defaults to 100644. */
  newMode?: string | null;
}

export type LineSelector = (hunkIndex: number, lineIndex: number) => boolean;

function quotePath(p: string): string {
  // git accepts unquoted paths with spaces; only quote when control chars are present.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f"\\]/.test(p)) {
    return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
  }
  return p;
}

function fileHeader(src: PatchSource, opts: { forceModify?: boolean } = {}): string {
  const oldPath = src.oldPath;
  const newPath = src.newPath;
  const pathForGit = newPath ?? oldPath ?? 'file';
  let out = `diff --git a/${quotePath(oldPath ?? pathForGit)} b/${quotePath(newPath ?? pathForGit)}\n`;
  if (oldPath === null && !opts.forceModify) {
    out += `new file mode ${src.newMode ?? '100644'}\n`;
    out += `--- /dev/null\n`;
    out += `+++ b/${quotePath(pathForGit)}\n`;
  } else if (newPath === null && !opts.forceModify) {
    out += `deleted file mode ${src.newMode ?? '100644'}\n`;
    out += `--- a/${quotePath(pathForGit)}\n`;
    out += `+++ /dev/null\n`;
  } else {
    out += `--- a/${quotePath(oldPath ?? pathForGit)}\n`;
    out += `+++ b/${quotePath(newPath ?? pathForGit)}\n`;
  }
  return out;
}

/**
 * Builds a patch (relative to HEAD) containing only the selected add/delete
 * lines. Unselected deletions become context, unselected additions are
 * omitted. Apply with `git apply --cached` to stage a partial file.
 * Returns null when nothing is selected.
 */
export function buildStagePatch(src: PatchSource, isSelected: LineSelector): string | null {
  let body = '';
  let delta = 0;
  let anySelected = false;
  let allDeletesSelected = true;
  let anyUnselected = false;

  src.hunks.forEach((hunk, hi) => {
    let text = '';
    let oldCount = 0;
    let newCount = 0;
    let hunkHasChange = false;
    hunk.lines.forEach((line, li) => {
      if (line.type === 'hunk') return;
      const nl = line.noNewline ? '\n\\ No newline at end of file' : '';
      if (line.type === 'context') {
        text += ` ${line.text}${nl}\n`;
        oldCount++;
        newCount++;
      } else if (line.type === 'add') {
        if (isSelected(hi, li)) {
          text += `+${line.text}${nl}\n`;
          newCount++;
          hunkHasChange = true;
        } else {
          anyUnselected = true;
        }
      } else if (line.type === 'delete') {
        if (isSelected(hi, li)) {
          text += `-${line.text}${nl}\n`;
          oldCount++;
          hunkHasChange = true;
        } else {
          text += ` ${line.text}${nl}\n`;
          oldCount++;
          newCount++;
          allDeletesSelected = false;
          anyUnselected = true;
        }
      }
    });
    if (!hunkHasChange) return;
    anySelected = true;
    const oldStart = hunk.oldStart;
    const newStart = hunk.oldLines === 0 && hunk.oldStart === 0 ? 1 : hunk.oldStart + delta;
    body += `@@ -${oldStart}${oldCount === 1 ? '' : `,${oldCount}`} +${newStart}${newCount === 1 ? '' : `,${newCount}`} @@\n`;
    body += text;
    delta += newCount - oldCount;
  });

  if (!anySelected) return null;
  // A deleted file where not every deletion was selected becomes a modification.
  const forceModify = src.newPath === null && (!allDeletesSelected || anyUnselected);
  const header = forceModify ? fileHeader({ ...src, newPath: src.oldPath }, { forceModify: true }) : fileHeader(src);
  return header + body;
}

/**
 * Builds a patch that, applied forward to the working tree, reverts the
 * selected lines to their HEAD state. The "old" side of this patch is the
 * current working tree. Unselected additions become context (they remain),
 * unselected deletions are omitted (they were never in the working tree).
 * Apply with `git apply --unidiff-zero --whitespace=nowarn`.
 */
export function buildDiscardPatch(src: PatchSource, isSelected: LineSelector): string | null {
  let body = '';
  let delta = 0;
  let anySelected = false;
  const path = src.newPath ?? src.oldPath ?? 'file';

  src.hunks.forEach((hunk, hi) => {
    let text = '';
    let oldCount = 0; // working tree side
    let newCount = 0; // after discard
    let hunkHasChange = false;
    hunk.lines.forEach((line, li) => {
      if (line.type === 'hunk') return;
      const nl = line.noNewline ? '\n\\ No newline at end of file' : '';
      if (line.type === 'context') {
        text += ` ${line.text}${nl}\n`;
        oldCount++;
        newCount++;
      } else if (line.type === 'add') {
        if (isSelected(hi, li)) {
          text += `-${line.text}${nl}\n`;
          oldCount++;
          hunkHasChange = true;
        } else {
          text += ` ${line.text}${nl}\n`;
          oldCount++;
          newCount++;
        }
      } else if (line.type === 'delete') {
        if (isSelected(hi, li)) {
          text += `+${line.text}${nl}\n`;
          newCount++;
          hunkHasChange = true;
        }
      }
    });
    if (!hunkHasChange) return;
    anySelected = true;
    const oldStart = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    const newStart = oldStart + delta;
    body += `@@ -${oldStart}${oldCount === 1 ? '' : `,${oldCount}`} +${newStart}${newCount === 1 ? '' : `,${newCount}`} @@\n`;
    body += text;
    delta += newCount - oldCount;
  });

  if (!anySelected) return null;
  let header = `diff --git a/${quotePath(path)} b/${quotePath(path)}\n`;
  header += `--- a/${quotePath(path)}\n`;
  header += `+++ b/${quotePath(path)}\n`;
  return header + body;
}

/** Convenience: selects everything (used for whole-hunk operations). */
export const selectAll: LineSelector = () => true;

export function selectHunk(hunkIndex: number): LineSelector {
  return (hi) => hi === hunkIndex;
}

/**
 * Combines several hunks (by index) into one selector, so `buildStagePatch`
 * produces a single multi-hunk patch instead of one patch per hunk. Used by
 * the AI commit splitter to stage several hunks of the same file for one
 * planned commit. Equivalent to OR-ing the `selectHunk` result for each
 * index in `hunkIndices`.
 */
export function selectHunks(hunkIndices: Iterable<number>): LineSelector {
  const set = new Set(hunkIndices);
  return (hi) => set.has(hi);
}
