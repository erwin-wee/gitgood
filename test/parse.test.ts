import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, parseUnifiedDiffs, synthesizeAddedDiff, countDiffLines } from '../src/shared/diff/parse';

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import a from 'a';
-import b from 'b';
+import b from 'b2';
+import c from 'c';
 
 export const x = 1;
@@ -10,3 +11,3 @@ function foo() {
   return 1;
-}
+};
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  it('parses hunks, line numbers and no-newline markers', () => {
    const d = parseUnifiedDiff(SAMPLE);
    expect(d.header.oldPath).toBe('src/app.ts');
    expect(d.header.newPath).toBe('src/app.ts');
    expect(d.hunks).toHaveLength(2);
    const h1 = d.hunks[0];
    expect(h1.oldStart).toBe(1);
    expect(h1.newLines).toBe(5);
    expect(h1.lines.map((l) => l.type)).toEqual(['context', 'delete', 'add', 'add', 'context', 'context']);
    expect(h1.lines[1].oldLineNumber).toBe(2);
    expect(h1.lines[1].newLineNumber).toBeNull();
    expect(h1.lines[2].newLineNumber).toBe(2);
    expect(h1.lines[3].newLineNumber).toBe(3);
    expect(h1.lines[4].oldLineNumber).toBe(3);
    expect(h1.lines[4].newLineNumber).toBe(4);
    const h2 = d.hunks[1];
    expect(h2.lines[h2.lines.length - 1].noNewline).toBe(true);
    expect(h2.lines[h2.lines.length - 1].text).toBe('};');
    expect(countDiffLines(d.hunks)).toEqual({ total: 9, additions: 3, deletions: 2 });
  });

  it('detects new, deleted and binary files', () => {
    const newFile = parseUnifiedDiff(`diff --git a/x.txt b/x.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+hello\n`);
    expect(newFile.header.isNew).toBe(true);
    expect(newFile.header.oldPath).toBeNull();
    expect(newFile.hunks[0].lines[0].newLineNumber).toBe(1);

    const deleted = parseUnifiedDiff(`diff --git a/x.txt b/x.txt\ndeleted file mode 100644\n--- a/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n`);
    expect(deleted.header.isDeleted).toBe(true);
    expect(deleted.header.newPath).toBeNull();

    const binary = parseUnifiedDiff(`diff --git a/a.png b/a.png\nindex 1..2 100644\nBinary files a/a.png and b/a.png differ\n`);
    expect(binary.header.isBinary).toBe(true);
  });

  it('parses renames and multiple files', () => {
    const text = `diff --git a/old.ts b/new.ts\nsimilarity index 95%\nrename from old.ts\nrename to new.ts\nindex 1..2 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-1\n+2\n`;
    const all = parseUnifiedDiffs(text);
    expect(all).toHaveLength(2);
    expect(all[0].header.isRename).toBe(true);
    expect(all[0].header.oldPath).toBe('old.ts');
    expect(all[0].header.newPath).toBe('new.ts');
    expect(all[1].hunks[0].lines).toHaveLength(2);
  });

  it('handles blank context lines without a leading space', () => {
    const d = parseUnifiedDiff(`--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n`);
    expect(d.hunks[0].lines.map((l) => l.type)).toEqual(['context', 'context', 'delete', 'add']);
  });

  it('synthesizes an added diff for untracked files', () => {
    const d = synthesizeAddedDiff('n.txt', 'one\ntwo');
    expect(d.header.isNew).toBe(true);
    expect(d.hunks[0].lines).toHaveLength(2);
    expect(d.hunks[0].lines[1].noNewline).toBe(true);
    expect(synthesizeAddedDiff('e.txt', '').hunks).toHaveLength(0);
  });
});
