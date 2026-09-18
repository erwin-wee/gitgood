import { describe, expect, it } from 'vitest';
import { applyResolutions, hasConflictMarkers, normalizeResolutionText, parseConflicts, resolutionForChoice } from '../src/shared/diff/conflicts';

const FILE = `before
<<<<<<< HEAD
ours line
=======
theirs line
>>>>>>> feature
middle
<<<<<<< HEAD
a
||||||| base
orig
=======
b
>>>>>>> feature
after
`;

describe('conflicts', () => {
  it('detects and parses conflict blocks including diff3 base', () => {
    expect(hasConflictMarkers(FILE)).toBe(true);
    const parsed = parseConflicts(FILE);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.oursLabel).toBe('HEAD');
    expect(parsed.theirsLabel).toBe('feature');
    expect(parsed.blocks[0].ours).toEqual(['ours line']);
    expect(parsed.blocks[0].theirs).toEqual(['theirs line']);
    expect(parsed.blocks[0].base).toBeNull();
    expect(parsed.blocks[1].base).toEqual(['orig']);
    expect(parsed.lines.slice(parsed.blocks[0].start, parsed.blocks[0].end)).toHaveLength(5);
  });

  it('applies resolutions and preserves untouched blocks', () => {
    const parsed = parseConflicts(FILE);
    const { content: out, ranges } = applyResolutions(parsed, new Map([[0, resolutionForChoice(parsed.blocks[0], 'both')]]));
    expect(out).toContain('before\nours line\ntheirs line\nmiddle\n<<<<<<< HEAD\na\n');
    expect(out.endsWith('after\n')).toBe(true);
    // "before" is line 0, the resolved block (ours+theirs) occupies lines 1-2.
    expect(ranges.get(0)).toEqual({ start: 1, end: 3 });
    expect(ranges.has(1)).toBe(false); // block 1 was left untouched (still has markers)
  });

  it('reports multi-block resolved ranges, accounting for earlier blocks changing line counts', () => {
    const parsed = parseConflicts(FILE);
    const { content: out, ranges } = applyResolutions(parsed, new Map([[0, ['x', 'y', 'z']], [1, ['w']]]));
    // before(1) + x,y,z(3) = lines 0-3, block 0 occupies [1,4)
    expect(ranges.get(0)).toEqual({ start: 1, end: 4 });
    const lines = out.split('\n');
    expect(lines.slice(ranges.get(0)!.start, ranges.get(0)!.end)).toEqual(['x', 'y', 'z']);
    // middle(1) follows immediately, then block 1's single resolved line.
    const block1 = ranges.get(1)!;
    expect(lines.slice(block1.start, block1.end)).toEqual(['w']);
    expect(lines[block1.start - 1]).toBe('middle');
  });

  it('records a zero-width range for an empty resolution', () => {
    const parsed = parseConflicts(FILE);
    const { ranges } = applyResolutions(parsed, new Map([[0, []]]));
    const r = ranges.get(0)!;
    expect(r.start).toBe(r.end);
    expect(r).toEqual({ start: 1, end: 1 });
  });

  it('preserves CRLF line endings and reports ranges the same way', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    const parsed = parseConflicts(crlf);
    const { content: out, ranges } = applyResolutions(parsed, new Map([[0, ['x']], [1, ['y']]]));
    expect(out).toBe('before\r\nx\r\nmiddle\r\ny\r\nafter\r\n');
    expect(hasConflictMarkers(out)).toBe(false);
    expect(ranges.get(0)).toEqual({ start: 1, end: 2 });
    expect(ranges.get(1)).toEqual({ start: 3, end: 4 });
  });

  it('normalizes model output', () => {
    expect(normalizeResolutionText('a\nb\n')).toEqual(['a', 'b']);
    expect(normalizeResolutionText('a\r\nb')).toEqual(['a', 'b']);
    expect(normalizeResolutionText('')).toEqual([]);
  });
});
