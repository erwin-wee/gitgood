import type { DiffHunk } from '../types';

/** Rebuild old-side lines from the new file and unified-diff hunks. */
export function reconstructOldLines(newLines: string[] | null, hunks: DiffHunk[]): string[] | null {
  if (newLines === null) return null;
  const oldLines: string[] = [];
  let oldNo = 1;
  let newNo = 1;

  for (const hunk of hunks) {
    while (oldNo < hunk.oldStart) {
      oldLines.push(newLines[newNo - 1] ?? '');
      oldNo++;
      newNo++;
    }
    for (const line of hunk.lines) {
      if (line.type !== 'add') {
        oldLines.push(line.text);
        oldNo++;
      }
      if (line.type !== 'delete') newNo++;
    }
  }

  while (newNo <= newLines.length) {
    oldLines.push(newLines[newNo - 1]);
    newNo++;
  }
  return oldLines;
}
