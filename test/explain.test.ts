import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/shared/diff/parse';
import { buildRangeContext, explainCacheKey, indexNewSideLines, markSelectedRange, splitPatchByFile, validateExplanation, validateFollowUpAnswer } from '../src/main/ai/explain-core';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,3 +10,4 @@ function main() {',
  '   const a = 1;',
  '-  const b = 2;',
  '+  const b = 20;',
  '+  const c = 30;',
  '   return a + b;',
  ' }',
  '',
].join('\n');

function hunks(text = DIFF) {
  return parseUnifiedDiff(text).hunks;
}

describe('validateExplanation', () => {
  const knownPaths = new Map<string, Set<number>>([['src/app.ts', indexNewSideLines(hunks())]]);

  it('accepts a well-formed response and keeps valid references', () => {
    const raw = {
      whatChanged: 'Renamed b and gave it a new value, and added c.',
      why: 'Likely a rename for clarity.',
      impact: 'Callers of b will need updating.',
      watchOutFor: ['Check other usages of b'],
      references: [{ path: 'src/app.ts', line: 11, label: 'the new value of b' }],
    };
    const { explanation, droppedReferences } = validateExplanation(raw, 'claude-opus-5', false, knownPaths);
    expect(explanation).not.toBeNull();
    expect(explanation!.whatChanged).toContain('Renamed b');
    expect(explanation!.references).toEqual([{ path: 'src/app.ts', line: 11, label: 'the new value of b' }]);
    expect(droppedReferences).toBe(0);
    expect(explanation!.droppedReferences).toBe(0);
    expect(explanation!.model).toBe('claude-opus-5');
  });

  it('rejects output with an empty whatChanged section', () => {
    const raw = { whatChanged: '   ', why: 'x', impact: 'y', watchOutFor: [], references: [] };
    const { explanation, droppedReferences } = validateExplanation(raw, 'm', false, knownPaths);
    expect(explanation).toBeNull();
    expect(droppedReferences).toBe(0);
  });

  it('drops references to unknown paths, unknown lines, and malformed entries, and counts them', () => {
    const raw = {
      whatChanged: 'Something changed.',
      why: '',
      impact: '',
      watchOutFor: [],
      references: [
        { path: 'src/app.ts', line: 11, label: 'valid' }, // kept
        { path: 'src/other.ts', line: 1, label: 'unknown path' }, // dropped: path not known
        { path: 'src/app.ts', line: 999, label: 'unknown line' }, // dropped: line not in diff
        { path: 'src/app.ts', label: 'missing label placeholder', line: null }, // kept: null line is a whole-file reference
        { path: '', line: null, label: 'empty path' }, // dropped
        'not an object', // dropped
      ],
    };
    const { explanation, droppedReferences } = validateExplanation(raw, 'm', false, knownPaths);
    expect(explanation).not.toBeNull();
    expect(explanation!.references).toEqual([
      { path: 'src/app.ts', line: 11, label: 'valid' },
      { path: 'src/app.ts', line: null, label: 'missing label placeholder' },
    ]);
    expect(droppedReferences).toBe(4);
  });

  it('caps text fields and watchOutFor to their limits', () => {
    const raw = {
      whatChanged: 'a'.repeat(3000),
      why: 'b'.repeat(3000),
      impact: 'c'.repeat(3000),
      watchOutFor: Array.from({ length: 20 }, (_, i) => `item ${i}`),
      references: [],
    };
    const { explanation } = validateExplanation(raw, 'm', false, knownPaths);
    expect(explanation!.whatChanged.length).toBe(2000);
    expect(explanation!.why.length).toBe(2000);
    expect(explanation!.impact.length).toBe(2000);
    expect(explanation!.watchOutFor).toHaveLength(8);
  });

  it('treats non-object/garbage input as an invalid (rejected) response', () => {
    expect(validateExplanation(null, 'm', false, knownPaths).explanation).toBeNull();
    expect(validateExplanation('a string', 'm', false, knownPaths).explanation).toBeNull();
    expect(validateExplanation(42, 'm', false, knownPaths).explanation).toBeNull();
  });
});

describe('validateFollowUpAnswer', () => {
  it('accepts a trimmed, capped answer', () => {
    expect(validateFollowUpAnswer({ answer: '  it was removed because it was dead code.  ' })).toBe('it was removed because it was dead code.');
  });
  it('rejects an empty or missing answer', () => {
    expect(validateFollowUpAnswer({ answer: '   ' })).toBeNull();
    expect(validateFollowUpAnswer({})).toBeNull();
    expect(validateFollowUpAnswer(null)).toBeNull();
  });
});

describe('splitPatchByFile', () => {
  it('splits a concatenated multi-file patch back into per-file blocks keyed by the new path', () => {
    const patch = [DIFF.trim(), 'diff --git a/README.md b/README.md\nindex 1..2 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n'].join('\n');
    const blocks = splitPatchByFile(patch);
    expect([...blocks.keys()].sort()).toEqual(['README.md', 'src/app.ts']);
    expect(blocks.get('src/app.ts')).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(blocks.get('README.md')).toContain('+new');
  });

  it('returns an empty map for empty input', () => {
    expect(splitPatchByFile('').size).toBe(0);
    expect(splitPatchByFile('   ').size).toBe(0);
  });
});

describe('markSelectedRange', () => {
  it('marks only the annotated lines whose [new:N] falls within the range', () => {
    const annotated = 'header\n[new:  10]  context\n[new:  11] -removed shown as del is different\n[new:  12] +added';
    const marked = markSelectedRange(annotated, 12, 12);
    const lines = marked.split('\n');
    expect(lines[1]).not.toContain('<== selected');
    expect(lines[3]).toContain('<== selected');
  });
});

describe('buildRangeContext', () => {
  it('returns numbered lines around the hunk, bounded by the file length', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n') + '\n';
    const hunk = hunks()[0];
    const ctx = buildRangeContext(content, null, { ...hunk, newStart: 2, newLines: 2 }, 40);
    expect(ctx.split('\n')).toHaveLength(5);
    expect(ctx).toContain('line 1');
    expect(ctx).toContain('line 5');
  });

  it('returns an empty string when no content is available', () => {
    expect(buildRangeContext(null, null, hunks()[0], 40)).toBe('');
  });
});

describe('explainCacheKey', () => {
  it('produces distinct, stable keys per target shape', () => {
    const a = explainCacheKey({ kind: 'commit', sha: 'abc' });
    const b = explainCacheKey({ kind: 'commit', sha: 'abc' });
    const c = explainCacheKey({ kind: 'file', source: { kind: 'working' }, path: 'src/app.ts' });
    const d = explainCacheKey({ kind: 'range', source: { kind: 'commit', sha: 'abc' }, path: 'src/app.ts', hunkIndex: 0, startLine: 1, endLine: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(c).not.toBe(d);
  });
});
