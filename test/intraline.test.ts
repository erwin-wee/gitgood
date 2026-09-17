import { describe, expect, it } from 'vitest';
import { intralineDiff, segmentByRanges, tokenize } from '../src/shared/diff/intraline';

describe('intralineDiff', () => {
  it('tokenizes identifiers, whitespace and punctuation', () => {
    expect(tokenize('foo(bar, 1)').map((t) => t.text)).toEqual(['foo', '(', 'bar', ',', ' ', '1', ')']);
  });

  it('highlights only the changed token', () => {
    const r = intralineDiff('const total = price * qty;', 'const total = price * quantity;');
    expect(r).not.toBeNull();
    expect(r!.old).toEqual([{ start: 22, end: 25 }]);
    expect(r!.new).toEqual([{ start: 22, end: 30 }]);
  });

  it('returns null for entirely different lines', () => {
    expect(intralineDiff('alpha beta gamma', 'zzz yyy xxx')).toBeNull();
  });

  it('segments text by ranges', () => {
    const segs = segmentByRanges('hello world', [{ start: 6, end: 11 }]);
    expect(segs).toEqual([
      { text: 'hello ', changed: false },
      { text: 'world', changed: true },
    ]);
  });
});
