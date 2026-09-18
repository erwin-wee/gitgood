import { describe, expect, it } from 'vitest';
import { classifyStaleBranches, parseBatchCheckLine, parseCountObjects, selectTopBlobs, type RawBlob } from '../src/main/git/health';
import type { Branch } from '../src/shared/types';

describe('parseBatchCheckLine', () => {
  it('parses a blob line with a simple path', () => {
    expect(parseBatchCheckLine('blob aabbccdd11223344 12345 src/app.ts')).toEqual({ sha: 'aabbccdd11223344', size: 12345, path: 'src/app.ts' });
  });

  it('keeps a path with spaces intact', () => {
    expect(parseBatchCheckLine('blob aabbccdd 999 assets/my photo 2024.png')).toEqual({ sha: 'aabbccdd', size: 999, path: 'assets/my photo 2024.png' });
  });

  it('ignores non-blob objects (commits, trees) and blobs with no path', () => {
    expect(parseBatchCheckLine('commit aabbccdd 300')).toBeNull();
    expect(parseBatchCheckLine('tree aabbccdd 120')).toBeNull();
    expect(parseBatchCheckLine('blob aabbccdd 42')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseBatchCheckLine('')).toBeNull();
    expect(parseBatchCheckLine('missing aabbccdd')).toBeNull();
  });
});

describe('selectTopBlobs (bounded top-N)', () => {
  it('keeps only the N largest, largest first', () => {
    const blobs: RawBlob[] = [
      { sha: 'a', size: 10, path: 'a.bin' },
      { sha: 'b', size: 500, path: 'b.bin' },
      { sha: 'c', size: 50, path: 'c.bin' },
      { sha: 'd', size: 5000, path: 'd.bin' },
      { sha: 'e', size: 1, path: 'e.bin' },
    ];
    const top = selectTopBlobs(blobs, 3);
    expect(top.map((b) => b.sha)).toEqual(['d', 'b', 'c']);
  });

  it('handles fewer items than the limit', () => {
    const blobs: RawBlob[] = [{ sha: 'a', size: 10, path: 'a.bin' }];
    expect(selectTopBlobs(blobs, 25).map((b) => b.sha)).toEqual(['a']);
  });

  it('a limit of 0 keeps nothing', () => {
    expect(selectTopBlobs([{ sha: 'a', size: 10, path: 'a.bin' }], 0)).toEqual([]);
  });

  it('replaces the smallest kept item as bigger ones stream in, one at a time', () => {
    const top: RawBlob[] = [];
    const stream: RawBlob[] = [
      { sha: '1', size: 100, path: '1.bin' },
      { sha: '2', size: 200, path: '2.bin' },
      { sha: '3', size: 50, path: '3.bin' },
      { sha: '4', size: 9000, path: '4.bin' },
    ];
    for (const b of stream) top.push(b);
    expect(selectTopBlobs(top, 2).map((b) => b.sha)).toEqual(['4', '2']);
  });
});

function makeBranch(overrides: Partial<Branch>): Branch {
  return {
    name: 'feature',
    kind: 'local',
    remote: null,
    sha: 'deadbeef',
    upstream: null,
    isCurrent: false,
    lastCommitDate: new Date().toISOString(),
    lastCommitSubject: 'subject',
    lastCommitAuthor: 'author',
    ahead: 0,
    behind: 0,
    isDefault: false,
    unpublished: false,
    upstreamGone: false,
    ...overrides,
  };
}

describe('classifyStaleBranches', () => {
  const now = Date.parse('2024-06-01T00:00:00Z');

  it('classifies merged, inactive and gone-upstream branches, with matching reasons', () => {
    const branches: Branch[] = [
      makeBranch({ name: 'merged-feature', lastCommitDate: '2024-05-30T00:00:00Z' }),
      makeBranch({ name: 'old-feature', lastCommitDate: '2024-01-01T00:00:00Z' }),
      makeBranch({ name: 'gone-feature', upstream: 'origin/gone-feature', upstreamGone: true, lastCommitDate: '2024-05-30T00:00:00Z' }),
      makeBranch({ name: 'fresh-feature', lastCommitDate: '2024-05-31T00:00:00Z' }),
    ];
    const merged = new Set(['merged-feature']);
    const result = classifyStaleBranches(branches, merged, { staleBranchDays: 90, now });
    const byName = Object.fromEntries(result.map((b) => [b.name, b]));
    expect(byName['merged-feature'].reason).toEqual(['merged']);
    expect(byName['old-feature'].reason).toEqual(['inactive']);
    expect(byName['gone-feature'].reason).toEqual(['gone']);
    expect(byName['fresh-feature']).toBeUndefined();
  });

  it('never excludes the current or default branch from the list, but marks them protected', () => {
    const branches: Branch[] = [makeBranch({ name: 'main', isCurrent: true, isDefault: true, lastCommitDate: '2024-01-01T00:00:00Z' })];
    const result = classifyStaleBranches(branches, new Set(), { staleBranchDays: 90, now });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'main', protected: true, reason: ['inactive'] });
  });

  it('does not mark the default branch merged into itself', () => {
    const branches: Branch[] = [makeBranch({ name: 'main', isDefault: true, lastCommitDate: '2024-05-31T00:00:00Z' })];
    const result = classifyStaleBranches(branches, new Set(['main']), { staleBranchDays: 90, now });
    expect(result).toHaveLength(0);
  });

  it('respects an explicit protected-names set', () => {
    const branches: Branch[] = [makeBranch({ name: 'release', lastCommitDate: '2024-01-01T00:00:00Z' })];
    const result = classifyStaleBranches(branches, new Set(), { staleBranchDays: 90, now, protectedNames: new Set(['release']) });
    expect(result[0]).toMatchObject({ protected: true });
  });

  it('ignores remote branches', () => {
    const branches: Branch[] = [makeBranch({ name: 'origin/old', kind: 'remote', remote: 'origin', lastCommitDate: '2024-01-01T00:00:00Z' })];
    expect(classifyStaleBranches(branches, new Set(), { staleBranchDays: 90, now })).toEqual([]);
  });
});

describe('parseCountObjects', () => {
  it('parses git count-objects -v output, converting KiB sizes to bytes', () => {
    const output = ['count: 12', 'size: 48', 'in-pack: 100', 'packs: 2', 'size-pack: 500', 'prune-packable: 0', 'garbage: 1', 'size-garbage: 10', ''].join('\n');
    expect(parseCountObjects(output)).toEqual({
      looseObjectCount: 12,
      looseObjectBytes: 48 * 1024,
      packCount: 2,
      packBytes: 500 * 1024,
      garbageCount: 1,
      garbageBytes: 10 * 1024,
    });
  });

  it('defaults missing fields to zero', () => {
    expect(parseCountObjects('')).toEqual({ looseObjectCount: 0, looseObjectBytes: 0, packCount: 0, packBytes: 0, garbageCount: 0, garbageBytes: 0 });
  });
});
