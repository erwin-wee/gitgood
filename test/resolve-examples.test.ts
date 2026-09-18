import { describe, expect, it } from 'vitest';
import { capExamples, trimManualResolution } from '../src/main/ai/resolve-examples';

const CONFLICTED = [
  'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10',
  'line 11', 'line 12', 'line 13', 'line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20',
  'line 21', 'line 22', 'line 23', 'line 24', 'line 25',
  '<<<<<<< HEAD',
  'ours',
  '=======',
  'theirs',
  '>>>>>>> feature',
  'line 26', 'line 27', 'line 28', 'line 29', 'line 30', 'line 31', 'line 32', 'line 33', 'line 34', 'line 35',
  'line 36', 'line 37', 'line 38', 'line 39', 'line 40', 'line 41', 'line 42', 'line 43', 'line 44', 'line 45',
].join('\n') + '\n';

describe('trimManualResolution', () => {
  it('returns null for content without conflict markers', () => {
    expect(trimManualResolution({ path: 'a.ts', original: 'no markers here\n', resolved: 'no markers here\n' })).toBeNull();
  });

  it('trims a long file to the conflict block plus 20 lines of context on each side', () => {
    const example = trimManualResolution({ path: 'a.ts', original: CONFLICTED, resolved: 'ours + theirs\n' });
    expect(example).not.toBeNull();
    expect(example!.path).toBe('a.ts');
    // 20 lines of leading context (lines 6-25), an ellipsis for the skipped head, the block itself,
    // 20 lines of trailing context (26-45), and an ellipsis is NOT added at the end since we reach EOF.
    expect(example!.original).toContain('…');
    expect(example!.original).toContain('<<<<<<< HEAD');
    expect(example!.original).toContain('line 6');
    expect(example!.original).not.toContain('line 5\n');
    expect(example!.original).toContain('line 45');
    expect(example!.original.split('\n').length).toBeLessThan(CONFLICTED.split('\n').length);
  });

  it('keeps a short resolution untrimmed', () => {
    const short = ['a', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> f', 'b'].join('\n');
    const example = trimManualResolution({ path: 'b.ts', original: short, resolved: 'x\ny\n' });
    expect(example!.resolved).toBe('x\ny\n');
    expect(example!.original).not.toContain('…');
  });
});

describe('capExamples', () => {
  const make = (n: number, size: number) => ({ path: `f${n}.ts`, original: 'o'.repeat(size), resolved: 'r'.repeat(size) });

  it('caps at 3 examples', () => {
    const examples = [make(1, 10), make(2, 10), make(3, 10), make(4, 10)];
    expect(capExamples(examples)).toHaveLength(3);
  });

  it('caps total size at 12,000 bytes, dropping whatever does not fit', () => {
    const examples = [make(1, 5000), make(2, 5000), make(3, 5000)];
    const capped = capExamples(examples);
    const total = capped.reduce((n, e) => n + e.original.length + e.resolved.length, 0);
    expect(total).toBeLessThanOrEqual(12_000);
    expect(capped.length).toBeLessThan(3);
  });

  it('returns everything when well under both caps', () => {
    const examples = [make(1, 10), make(2, 10)];
    expect(capExamples(examples)).toEqual(examples);
  });
});
