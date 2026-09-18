import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/shared/diff/parse';
import { buildDiscardPatch, buildStagePatch, selectHunk, selectHunks } from '../src/shared/diff/patch';

const DIFF = `diff --git a/f.txt b/f.txt
index 1..2 100644
--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,6 @@
 line1
-line2
+line2 changed
 line3
+inserted
 line4
-line5
+line5 changed
`;

describe('buildStagePatch', () => {
  it('includes only selected changes and turns unselected deletions into context', () => {
    const d = parseUnifiedDiff(DIFF);
    // select only the "inserted" addition (hunk 0, line index 4)
    const patch = buildStagePatch({ oldPath: 'f.txt', newPath: 'f.txt', hunks: d.hunks }, (h, l) => h === 0 && l === 4);
    expect(patch).not.toBeNull();
    expect(patch).toContain('--- a/f.txt\n+++ b/f.txt\n');
    expect(patch).toContain('@@ -1,5 +1,6 @@\n');
    expect(patch).toContain(' line1\n line2\n line3\n+inserted\n line4\n line5\n');
    expect(patch).not.toContain('+line2 changed');
    expect(patch).not.toContain('-line5');
  });

  it('returns null when nothing is selected', () => {
    const d = parseUnifiedDiff(DIFF);
    expect(buildStagePatch({ oldPath: 'f.txt', newPath: 'f.txt', hunks: d.hunks }, () => false)).toBeNull();
  });

  it('emits new-file headers for untracked files', () => {
    const d = parseUnifiedDiff(`--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n`);
    const patch = buildStagePatch({ oldPath: null, newPath: 'n.txt', hunks: d.hunks }, (h, l) => l === 0);
    expect(patch).toContain('new file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+a\n');
  });

  it('keeps the no-newline marker on the last selected line', () => {
    const d = parseUnifiedDiff(`--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n`);
    const patch = buildStagePatch({ oldPath: 'f', newPath: 'f', hunks: d.hunks }, () => true);
    expect(patch).toContain('-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
  });
});

const TWO_HUNK_DIFF = `diff --git a/f.txt b/f.txt
index 1..2 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 top1
-top2
+top2 changed
 top3
@@ -10,3 +10,3 @@
 bottom1
-bottom2
+bottom2 changed
 bottom3
`;

describe('selectHunks', () => {
  it('combines several selectHunk selectors so one patch holds every selected hunk', () => {
    const d = parseUnifiedDiff(TWO_HUNK_DIFF);
    const combined = buildStagePatch({ oldPath: 'f.txt', newPath: 'f.txt', hunks: d.hunks }, selectHunks([0, 1]));
    const manual = buildStagePatch({ oldPath: 'f.txt', newPath: 'f.txt', hunks: d.hunks }, (h, l) => selectHunk(0)(h, l) || selectHunk(1)(h, l));
    expect(combined).not.toBeNull();
    expect(combined).toEqual(manual);
    expect(combined).toContain('top2 changed');
    expect(combined).toContain('bottom2 changed');
  });

  it('selects only the given hunks, leaving the others out entirely', () => {
    const d = parseUnifiedDiff(TWO_HUNK_DIFF);
    const patch = buildStagePatch({ oldPath: 'f.txt', newPath: 'f.txt', hunks: d.hunks }, selectHunks([1]));
    expect(patch).not.toBeNull();
    expect(patch).not.toContain('top2 changed');
    expect(patch).toContain('bottom2 changed');
  });
});

describe('buildDiscardPatch', () => {
  it('reverts selected changes relative to the working tree', () => {
    const d = parseUnifiedDiff(DIFF);
    // discard the "line2 changed" modification (delete idx 1 and add idx 2)
    const patch = buildDiscardPatch({ oldPath: 'f.txt', newPath: 'f.txt', hunks: d.hunks }, (h, l) => l === 1 || l === 2);
    expect(patch).not.toBeNull();
    // working tree has 6 lines; after discard still 6
    expect(patch).toContain('@@ -1,6 +1,6 @@\n');
    expect(patch).toContain(' line1\n+line2\n-line2 changed\n line3\n inserted\n line4\n line5 changed\n');
  });
});
