import { describe, expect, it } from 'vitest';
import type { CommitFile, DiffHunk, ReviewFinding, WorkingFile } from '../src/shared/types';
import { parseUnifiedDiff, parseUnifiedDiffs } from '../src/shared/diff/parse';
import { buildStagePatch } from '../src/shared/diff/patch';
import { annotateHunks, buildReviewPayload, changedLineCount, filterNearbyTestPaths, findingId, foldCommentsIntoBody, hashHunks, indexNewSide, linkedIssueNumbers, mergeDuplicates, remapLine, replaceLinesInContent, skipReason, stripFences, validateFindings, verdictFloor } from '../src/main/ai/review-core';
import { getPatchForFiles, renderAddedFilePatch } from '../src/main/git/diff';
import type { GitClient } from '../src/main/git/git';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,7 +10,8 @@ function main() {',
  '   const a = 1;',
  '-  const b = 2;',
  '-  const c = 3;',
  '+  const b = 20;',
  '+  const c = 30;',
  '+  const d = 40;',
  '   return a + b + c;',
  ' }',
  '@@ -40,3 +41,4 @@ export function tail() {',
  '   // end',
  '+  console.log("debug");',
  '   return 0;',
  ' }',
  '\\ No newline at end of file',
  '',
].join('\n');

function hunks(text = DIFF): DiffHunk[] {
  return parseUnifiedDiff(text).hunks;
}

const file = (path: string, extra: Partial<CommitFile> = {}): CommitFile => ({ path, oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, ...extra });

describe('annotateHunks', () => {
  it('prefixes new-side lines with [new:N] and deleted lines with [del], matching parse.ts numbering', () => {
    const out = annotateHunks(hunks());
    const lines = out.split('\n');
    expect(lines[0]).toBe('@@ -10,7 +10,8 @@ function main() {');
    expect(lines[1]).toBe('[new:  10]    const a = 1;');
    expect(lines[2]).toBe('[del]     -  const b = 2;');
    expect(lines[4]).toBe('[new:  11] +  const b = 20;');
    expect(lines[6]).toBe('[new:  13] +  const d = 40;');
    expect(lines[7]).toBe('[new:  14]    return a + b + c;');
    expect(out).toContain('[new:  42] +  console.log("debug");');
    expect(out.trimEnd().endsWith('\\ No newline at end of file')).toBe(true);
  });

  it('strips CRLF from annotated text', () => {
    const crlf = DIFF.replace(/\n/g, '\r\n');
    const out = annotateHunks(hunks(crlf));
    expect(out).not.toContain('\r');
    expect(out).toContain('[new:  11] +  const b = 20;');
  });
});

describe('indexNewSide / remapLine', () => {
  it('indexes add and context lines only', () => {
    const idx = indexNewSide(hunks());
    expect([...idx.lines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 41, 42, 43, 44]);
    expect(idx.hunkOf.get(14)).toBe(0);
    expect(idx.hunkOf.get(42)).toBe(1);
  });

  it('remaps a missing line to the next new-side line within 3 lines, else null', () => {
    const idx = indexNewSide(hunks());
    expect(remapLine(12, idx)).toBe(12);
    expect(remapLine(38, idx)).toBe(41);
    expect(remapLine(16, idx)).toBeNull();
    expect(remapLine(37, idx)).toBeNull();
  });
});

describe('validateFindings', () => {
  const raw = (over: Record<string, unknown>) => ({ line: 11, endLine: null, severity: 'warning', category: 'bug', title: 'Magic number', detail: 'Use a constant.', suggestion: null, confidence: 'high', ...over });

  it('keeps findings on diff lines and drops out-of-diff lines', () => {
    const { findings, dropped } = validateFindings({ findings: [raw({}), raw({ line: 300, title: 'Nowhere' })] }, 'src/app.ts', hunks(), 'balanced');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: 'src/app.ts', line: 11, severity: 'warning', category: 'bug', dismissed: false });
    expect(findings[0].id).toBe(findingId('src/app.ts', 11, 'Magic number'));
    expect(dropped).toBe(1);
  });

  it('remaps a deleted-line citation within 3 lines and drops one that is further away', () => {
    const { findings, dropped } = validateFindings({ findings: [raw({ line: 39, title: 'Near' }), raw({ line: 30, title: 'Far' })] }, 'src/app.ts', hunks(), 'balanced');
    expect(findings.map((f) => [f.title, f.line])).toEqual([['Near', 41]]);
    expect(dropped).toBe(1);
  });

  it('shifts ranges with the remap, enforces same hunk, and rejects inverted ranges', () => {
    const { findings, dropped } = validateFindings(
      { findings: [raw({ line: 11, endLine: 13, title: 'Range ok' }), raw({ line: 14, endLine: 42, title: 'Cross hunk' }), raw({ line: 13, endLine: 11, title: 'Inverted' })] },
      'src/app.ts',
      hunks(),
      'balanced',
    );
    expect(findings.map((f) => [f.title, f.line, f.endLine])).toEqual([['Range ok', 11, 13]]);
    expect(dropped).toBe(2);
  });

  it('merges duplicates keeping the higher severity', () => {
    const { findings } = validateFindings({ findings: [raw({ severity: 'nit', title: 'Magic number' }), raw({ severity: 'blocker', title: 'magic  number!' })] }, 'src/app.ts', hunks(), 'thorough');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('blocker');
  });

  it('strips code fences from suggestions, sets endLine, and rejects conflict markers', () => {
    const { findings, dropped } = validateFindings(
      { findings: [raw({ suggestion: '```ts\n  const b = B;\n```', title: 'Fenced' }), raw({ suggestion: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other', title: 'Markers' })] },
      'src/app.ts',
      hunks(),
      'balanced',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].suggestion).toBe('  const b = B;');
    expect(findings[0].endLine).toBe(11);
    expect(dropped).toBe(1);
  });

  it('drops malformed entries, overlong text and unknown severities', () => {
    const long = 'x'.repeat(700);
    const { findings, dropped } = validateFindings({ findings: [null, raw({ title: '' }), raw({ detail: long }), raw({ severity: 'critical' }), raw({ line: 'eleven' }), 'nope'] }, 'src/app.ts', hunks(), 'balanced');
    expect(findings).toHaveLength(0);
    expect(dropped).toBe(6);
  });

  it('drops low-confidence findings only in strict mode', () => {
    const payload = { findings: [raw({ confidence: 'low' })] };
    expect(validateFindings(payload, 'src/app.ts', hunks(), 'strict').findings).toHaveLength(0);
    expect(validateFindings(payload, 'src/app.ts', hunks(), 'strict').dropped).toBe(1);
    expect(validateFindings(payload, 'src/app.ts', hunks(), 'balanced').findings).toHaveLength(1);
  });

  it('accepts a bare array and defaults unknown categories to readability', () => {
    const { findings } = validateFindings([raw({ category: 'vibes' })], 'src/app.ts', hunks(), 'balanced');
    expect(findings[0].category).toBe('readability');
  });
});

describe('stripFences', () => {
  it('unwraps a fenced block and removes stray fences', () => {
    expect(stripFences('```js\nfoo();\n```')).toBe('foo();');
    expect(stripFences('```\nfoo();\nbar();\n```\n')).toBe('foo();\nbar();');
    expect(stripFences('plain')).toBe('plain');
    expect(stripFences('a\r\nb')).toBe('a\nb');
  });
});

describe('mergeDuplicates / verdictFloor', () => {
  const f = (over: Partial<ReviewFinding>): ReviewFinding => ({ id: 'x', path: 'a.ts', line: 1, endLine: null, severity: 'nit', category: 'style', title: 'T', detail: '', suggestion: null, confidence: 'medium', dismissed: false, ...over });

  it('sorts by severity then path and line', () => {
    const out = mergeDuplicates([f({ id: '1', severity: 'nit', path: 'b.ts', title: 'A' }), f({ id: '2', severity: 'blocker', path: 'z.ts', title: 'B' }), f({ id: '3', severity: 'warning', path: 'a.ts', line: 9, title: 'C' }), f({ id: '4', severity: 'warning', path: 'a.ts', line: 2, title: 'D' })]);
    expect(out.map((x) => x.id)).toEqual(['2', '4', '3', '1']);
  });

  it('derives the verdict floor from live findings', () => {
    expect(verdictFloor([])).toBe('approve');
    expect(verdictFloor([f({ severity: 'nit' })])).toBe('approve');
    expect(verdictFloor([f({ severity: 'warning' })])).toBe('comment');
    expect(verdictFloor([f({ severity: 'blocker' })])).toBe('request-changes');
    expect(verdictFloor([f({ severity: 'blocker', dismissed: true })])).toBe('approve');
  });
});

describe('skipReason', () => {
  it('skips lockfiles, binaries, generated dirs, minified assets and oversized files', () => {
    expect(skipReason(file('package-lock.json'), 5)).toBe('lockfile');
    expect(skipReason(file('web/yarn.lock'), 5)).toBe('lockfile');
    expect(skipReason(file('img/logo.png'), null)).toBe('binary or media file');
    expect(skipReason(file('bin/tool', { binary: true }), null)).toBe('binary file');
    expect(skipReason(file('dist/bundle.js'), 5)).toBe('build output or vendored code');
    expect(skipReason(file('pkg/vendor/lib.go'), 5)).toBe('build output or vendored code');
    expect(skipReason(file('assets/app.min.js'), 5)).toBe('minified or generated asset');
    expect(skipReason(file('src/big.ts'), 1501)).toMatch(/too large/);
    expect(skipReason(file('src/gen.ts'), 5, new Set(['src/gen.ts']))).toBe('marked linguist-generated');
    expect(skipReason(file('src/old.ts', { status: 'deleted' }), 5)).toBe('deleted file');
  });

  it('reviews ordinary source files', () => {
    expect(skipReason(file('src/app.ts'), 1500)).toBeNull();
    expect(skipReason(file('docs/vendor-notes.md'), 3)).toBeNull();
  });

  it('counts changed lines and hashes hunks stably', () => {
    expect(changedLineCount(hunks())).toBe(6);
    expect(hashHunks(hunks())).toBe(hashHunks(hunks()));
    expect(hashHunks(hunks())).not.toBe(hashHunks(hunks(DIFF.replace('const d = 40', 'const d = 41'))));
  });
});

describe('buildReviewPayload', () => {
  const f = (over: Partial<ReviewFinding>): ReviewFinding => ({ id: 'x', path: 'src/app.ts', line: 11, endLine: null, severity: 'warning', category: 'bug', title: 'Magic number', detail: 'Use a constant.', suggestion: null, confidence: 'high', dismissed: false, ...over });

  it('emits RIGHT-side comments, start_line only for ranges, suggestion blocks and the footer', () => {
    const payload = buildReviewPayload({ commitId: 'abc123', event: 'REQUEST_CHANGES', body: 'Looks mostly fine.', findings: [f({}), f({ id: 'y', line: 11, endLine: 13, suggestion: 'const B = 20;' })], footer: '_footer_' });
    expect(payload.commit_id).toBe('abc123');
    expect(payload.event).toBe('REQUEST_CHANGES');
    expect(payload.body).toBe('Looks mostly fine.\n\n_footer_');
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toEqual({ path: 'src/app.ts', line: 11, side: 'RIGHT', body: expect.stringContaining('**Magic number**') });
    expect(payload.comments[0]).not.toHaveProperty('start_line');
    expect(payload.comments[1]).toMatchObject({ path: 'src/app.ts', line: 13, start_line: 11, side: 'RIGHT', start_side: 'RIGHT' });
    expect(payload.comments[1].body).toContain('```suggestion\nconst B = 20;\n```');
  });

  it('uses the footer alone when the body is empty and omits it when null', () => {
    expect(buildReviewPayload({ commitId: 'a', event: 'APPROVE', body: '  ', findings: [], footer: '_f_' }).body).toBe('_f_');
    expect(buildReviewPayload({ commitId: 'a', event: 'APPROVE', body: 'ok', findings: [], footer: null }).body).toBe('ok');
  });

  it('folds comments into the body for the 422 retry', () => {
    const payload = buildReviewPayload({ commitId: 'a', event: 'COMMENT', body: 'Body', findings: [f({}), f({ id: 'y', line: 11, endLine: 13, title: 'Range' })], footer: null });
    const folded = foldCommentsIntoBody(payload);
    expect(folded.comments).toEqual([]);
    expect(folded.body).toContain('**Findings**');
    expect(folded.body).toContain('`src/app.ts:11` — Magic number');
    expect(folded.body).toContain('`src/app.ts:11-13` — Range');
    const noComments = { ...payload, comments: [] };
    expect(foldCommentsIntoBody(noComments)).toBe(noComments);
  });
});

describe('linkedIssueNumbers', () => {
  it('extracts unique issue references up to the cap', () => {
    expect(linkedIssueNumbers('Fixes #12 and closes #7. See #12 again, also (#99) and #100 #101')).toEqual([12, 7, 99]);
    expect(linkedIssueNumbers('no refs here, C#1 is a language')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pre-commit review
// ---------------------------------------------------------------------------

describe('replaceLinesInContent', () => {
  it('replaces a line range and preserves LF endings and a trailing newline', () => {
    const content = 'one\ntwo\nthree\nfour\n';
    expect(replaceLinesInContent(content, 2, 3, 'TWO\nTHREE')).toBe('one\nTWO\nTHREE\nfour\n');
  });

  it('preserves CRLF endings and no trailing newline', () => {
    const content = 'one\r\ntwo\r\nthree';
    expect(replaceLinesInContent(content, 2, 2, 'TWO')).toBe('one\r\nTWO\r\nthree');
  });

  it('accepts a suggestion written with the opposite line ending', () => {
    const content = 'one\r\ntwo\r\nthree\r\n';
    expect(replaceLinesInContent(content, 2, 2, 'TWO')).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('replaces a single line with an empty suggestion (deletion)', () => {
    expect(replaceLinesInContent('a\nb\nc\n', 2, 2, '')).toBe('a\nc\n');
  });
});

describe('filterNearbyTestPaths', () => {
  it('keeps only test paths sharing a directory with a changed file, capped', () => {
    const tests = ['src/app.test.ts', 'src/util/helper.test.ts', 'other/thing.test.ts'];
    expect(filterNearbyTestPaths(tests, ['src/app.ts'])).toEqual(['src/app.test.ts']);
    expect(filterNearbyTestPaths(tests, ['src/app.ts', 'src/util/helper.ts'])).toEqual(['src/app.test.ts', 'src/util/helper.test.ts']);
  });

  it('caps the result', () => {
    const tests = Array.from({ length: 250 }, (_, i) => `src/f${i}.test.ts`);
    expect(filterNearbyTestPaths(tests, ['src/app.ts'], 200)).toHaveLength(200);
  });

  it('matches the repository root directory ("") for top-level files', () => {
    expect(filterNearbyTestPaths(['app.test.ts'], ['app.ts'])).toEqual(['app.test.ts']);
  });
});

describe('renderAddedFilePatch', () => {
  it('round-trips through parseUnifiedDiffs with the same numbering buildStagePatch would produce', () => {
    const content = 'line one\nline two\nline three\n';
    const patch = renderAddedFilePatch('src/new.ts', content);
    expect(patch).not.toBeNull();
    const parsed = parseUnifiedDiffs(patch!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].header.isNew).toBe(true);
    expect(parsed[0].header.newPath).toBe('src/new.ts');
    expect(parsed[0].hunks[0].lines.map((l) => [l.type, l.newLineNumber, l.text])).toEqual([
      ['add', 1, 'line one'],
      ['add', 2, 'line two'],
      ['add', 3, 'line three'],
    ]);
  });

  it('returns null for an empty file', () => {
    expect(renderAddedFilePatch('src/empty.ts', '')).toBeNull();
  });
});

describe('getPatchForFiles (partial patches and untracked synthesis)', () => {
  const file = (path: string, status: WorkingFile['status']): WorkingFile => ({ path, oldPath: null, status, staged: false, unstaged: true, submodule: false, conflict: null, lfs: false });
  const fakeGit = {} as unknown as GitClient; // never called: every file below is either partial or untracked

  it('uses the caller-supplied partial patch verbatim, with numbering identical to buildStagePatch', async () => {
    const hunk: DiffHunk = {
      header: '@@ -1,3 +1,4 @@',
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      lines: [
        { type: 'context', text: 'a', oldLineNumber: 1, newLineNumber: 1, noNewline: false },
        { type: 'add', text: 'b', oldLineNumber: null, newLineNumber: 2, noNewline: false },
        { type: 'context', text: 'c', oldLineNumber: 2, newLineNumber: 3, noNewline: false },
        { type: 'add', text: 'd', oldLineNumber: null, newLineNumber: 4, noNewline: false },
      ],
    };
    const partial = buildStagePatch({ oldPath: 'src/app.ts', newPath: 'src/app.ts', hunks: [hunk] }, (hi, li) => li === 1)!;
    const { patch } = await getPatchForFiles(fakeGit, '/repo', [file('src/app.ts', 'modified')], 1_000_000, { 'src/app.ts': partial });
    expect(patch).toContain(partial);
    const parsed = parseUnifiedDiffs(patch);
    expect(parsed[0].hunks[0].lines.filter((l) => l.type === 'add').map((l) => l.newLineNumber)).toEqual([2]);
  });

  it('synthesizes an untracked file with file-own line numbers, distinct from a partial file in the same patch', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'gg-getpatch-'));
    await writeFile(join(root, 'brand-new.ts'), 'export const x = 1;\nexport const y = 2;\n', 'utf8');
    const { patch } = await getPatchForFiles(fakeGit, root, [file('brand-new.ts', 'untracked')], 1_000_000);
    const parsed = parseUnifiedDiffs(patch);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].header.isNew).toBe(true);
    expect(parsed[0].hunks[0].lines.map((l) => l.newLineNumber)).toEqual([1, 2]);
  });
});
