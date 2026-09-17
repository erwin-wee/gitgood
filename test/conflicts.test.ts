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
    const out = applyResolutions(parsed, new Map([[0, resolutionForChoice(parsed.blocks[0], 'both')]]));
    expect(out).toContain('before\nours line\ntheirs line\nmiddle\n<<<<<<< HEAD\na\n');
    expect(out.endsWith('after\n')).toBe(true);
  });

  it('preserves CRLF line endings', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    const parsed = parseConflicts(crlf);
    const out = applyResolutions(parsed, new Map([[0, ['x']], [1, ['y']]]));
    expect(out).toBe('before\r\nx\r\nmiddle\r\ny\r\nafter\r\n');
    expect(hasConflictMarkers(out)).toBe(false);
  });

  it('normalizes model output', () => {
    expect(normalizeResolutionText('a\nb\n')).toEqual(['a', 'b']);
    expect(normalizeResolutionText('a\r\nb')).toEqual(['a', 'b']);
    expect(normalizeResolutionText('')).toEqual([]);
  });
});
