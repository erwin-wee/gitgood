import { describe, expect, it } from 'vitest';
import type { DiffHunk, SplitHunk } from '../src/shared/types';
import { buildSplitPrompt } from '../src/main/ai/prompts';
import { classifySplitFile, computeHunkId, isAlreadyCoherent, SPLIT_SUMMARY_PLACEHOLDER, staleSplitPaths, validateSplitResponse } from '../src/main/ai/splitter-core';

function hunk(header: string, lines: { type: 'context' | 'add' | 'delete'; text: string }[]): DiffHunk {
  return {
    header,
    oldStart: 1,
    oldLines: lines.filter((l) => l.type !== 'add').length,
    newStart: 1,
    newLines: lines.filter((l) => l.type !== 'delete').length,
    lines: lines.map((l, i) => ({ type: l.type, text: l.text, oldLineNumber: l.type === 'add' ? null : i + 1, newLineNumber: l.type === 'delete' ? null : i + 1, noNewline: false })),
  };
}

describe('computeHunkId', () => {
  it('is stable across header line-number shifts for the same content', () => {
    const h1 = hunk('@@ -1,2 +1,2 @@', [{ type: 'context', text: 'a' }, { type: 'add', text: 'b' }]);
    const h2 = hunk('@@ -10,2 +12,2 @@', [{ type: 'context', text: 'a' }, { type: 'add', text: 'b' }]);
    expect(computeHunkId('f.ts', h1)).toBe(computeHunkId('f.ts', h2));
  });

  it('differs for different content or path', () => {
    const h1 = hunk('@@ -1,2 +1,2 @@', [{ type: 'add', text: 'b' }]);
    const h2 = hunk('@@ -1,2 +1,2 @@', [{ type: 'add', text: 'c' }]);
    expect(computeHunkId('f.ts', h1)).not.toBe(computeHunkId('f.ts', h2));
    expect(computeHunkId('f.ts', h1)).not.toBe(computeHunkId('g.ts', h1));
  });
});

describe('classifySplitFile', () => {
  it('excludes conflicted files regardless of status', () => {
    expect(classifySplitFile({ status: 'modified', conflict: 'both-modified', submodule: false }, true)).toBe('excluded');
  });
  it('treats untracked/renamed/copied/deleted/typechange as whole-file-only even with hunks', () => {
    for (const status of ['untracked', 'renamed', 'copied', 'deleted', 'typechange'] as const) {
      expect(classifySplitFile({ status, conflict: null, submodule: false }, true)).toBe('whole');
    }
  });
  it('treats a submodule as whole-file-only', () => {
    expect(classifySplitFile({ status: 'modified', conflict: null, submodule: true }, true)).toBe('whole');
  });
  it('splits a plain modified file with real hunks', () => {
    expect(classifySplitFile({ status: 'modified', conflict: null, submodule: false }, true)).toBe('hunks');
  });
  it('excludes a modified file with no text hunks (binary, mode-only, etc.)', () => {
    expect(classifySplitFile({ status: 'modified', conflict: null, submodule: false }, false)).toBe('excluded');
  });
});

function h(id: string, path: string): SplitHunk {
  return { id, path, hunkIndex: 0, header: '@@ -1 +1 @@', additions: 1, deletions: 0 };
}

describe('validateSplitResponse', () => {
  const hunks: SplitHunk[] = [h('a1', 'a.ts'), h('a2', 'a.ts'), h('b1', 'b.ts')];

  it('builds commits from valid assignments', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'Fix bug', description: '', hunkIds: ['a1'], wholeFiles: [], rationale: 'r' }, { summary: 'Add feature', description: 'body', hunkIds: ['a2', 'b1'], wholeFiles: [], rationale: 'r2' }] }, hunks, []);
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]).toMatchObject({ summary: 'Fix bug', hunkIds: ['a1'] });
    expect(result.commits[1]).toMatchObject({ summary: 'Add feature', hunkIds: ['a2', 'b1'] });
    expect(result.unassigned).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('drops unknown hunk ids and unknown whole-file paths with a warning', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'x', description: '', hunkIds: ['a1', 'bogus'], wholeFiles: ['nope.txt'], rationale: '' }] }, hunks, []);
    expect(result.commits[0].hunkIds).toEqual(['a1']);
    expect(result.warnings.some((w) => w.includes('bogus'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('nope.txt'))).toBe(true);
  });

  it('keeps a duplicate-assigned hunk in the first commit only, dropping a second commit left empty by the duplicate', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'first', description: '', hunkIds: ['a1'], wholeFiles: [], rationale: '' }, { summary: 'second', description: '', hunkIds: ['a1'], wholeFiles: [], rationale: '' }] }, hunks, []);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].hunkIds).toEqual(['a1']);
    expect(result.warnings.some((w) => /more than one commit/.test(w))).toBe(true);
  });

  it('keeps a duplicate-assigned hunk in the first commit when the second commit has other hunks too', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'first', description: '', hunkIds: ['a1'], wholeFiles: [], rationale: '' }, { summary: 'second', description: '', hunkIds: ['a1', 'b1'], wholeFiles: [], rationale: '' }] }, hunks, []);
    expect(result.commits[0].hunkIds).toEqual(['a1']);
    expect(result.commits[1].hunkIds).toEqual(['b1']);
  });

  it('leaves an unassigned hunk in the unassigned bucket instead of committing it silently', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'x', description: '', hunkIds: ['a1'], wholeFiles: [], rationale: '' }] }, hunks, []);
    expect(result.unassigned).toEqual(expect.arrayContaining(['a2', 'b1']));
  });

  it('converts a whole-file assignment that overlaps a splittable file into its hunk ids', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'x', description: '', hunkIds: [], wholeFiles: ['a.ts'], rationale: '' }] }, hunks, []);
    expect(result.commits[0].hunkIds.sort()).toEqual(['a1', 'a2']);
    expect(result.commits[0].wholeFiles).toEqual([]);
    expect(result.warnings.some((w) => /split into its hunks/.test(w))).toBe(true);
  });

  it('keeps a genuine whole-file-only assignment as-is', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'x', description: '', hunkIds: [], wholeFiles: ['new.txt'], rationale: '' }] }, [], ['new.txt']);
    expect(result.commits[0].wholeFiles).toEqual(['new.txt']);
  });

  it('gives an empty summary a placeholder and a warning', () => {
    const result = validateSplitResponse({ commits: [{ summary: '  ', description: '', hunkIds: ['a1'], wholeFiles: [], rationale: '' }] }, hunks, []);
    expect(result.commits[0].summary).toBe(SPLIT_SUMMARY_PLACEHOLDER);
    expect(result.warnings.some((w) => /empty summary/.test(w))).toBe(true);
  });

  it('truncates an over-long summary to 72 characters', () => {
    const long = 'x'.repeat(100);
    const result = validateSplitResponse({ commits: [{ summary: long, description: '', hunkIds: ['a1'], wholeFiles: [], rationale: '' }] }, hunks, []);
    expect(result.commits[0].summary).toHaveLength(72);
  });

  it('drops an empty commit (no hunks, no whole files) entirely', () => {
    const result = validateSplitResponse({ commits: [{ summary: 'nothing', description: '', hunkIds: [], wholeFiles: [], rationale: '' }] }, hunks, []);
    expect(result.commits).toHaveLength(0);
  });
});

describe('isAlreadyCoherent', () => {
  it('is true for zero or one commit, false for two or more', () => {
    expect(isAlreadyCoherent([])).toBe(true);
    expect(isAlreadyCoherent([{ id: '1', summary: 's', description: '', hunkIds: [], wholeFiles: [], rationale: '' }])).toBe(true);
    expect(
      isAlreadyCoherent([
        { id: '1', summary: 's', description: '', hunkIds: [], wholeFiles: [], rationale: '' },
        { id: '2', summary: 's2', description: '', hunkIds: [], wholeFiles: [], rationale: '' },
      ]),
    ).toBe(false);
  });
});

describe('buildSplitPrompt', () => {
  const oneHunk = { id: 'a1', path: 'a.ts', header: '@@ -1,2 +1,2 @@', language: 'typescript', additions: 1, deletions: 1 };

  it('includes hunk bodies when the byte budget is not exceeded', () => {
    const prompt = buildSplitPrompt({ branch: 'main', hunks: [{ ...oneHunk, body: '[new:1]  const x = 1\n[del]     -old line' }], wholeFileOnly: [], bodiesIncluded: true });
    expect(prompt).toContain('[new:1]');
    expect(prompt).toContain('const x = 1');
    expect(prompt).not.toContain('only hunk headers and line-count stats');
  });

  it('sends no hunk bodies when the byte budget was exceeded (file-only mode)', () => {
    const prompt = buildSplitPrompt({ branch: 'main', hunks: [{ ...oneHunk, body: null }], wholeFileOnly: [], bodiesIncluded: false });
    expect(prompt).toContain('only hunk headers and line-count stats');
    expect(prompt).toContain(oneHunk.id);
    expect(prompt).toContain(oneHunk.header);
    expect(prompt).not.toContain('const x = 1');
    expect(prompt).not.toContain('[new:');
  });

  it('lists whole-file-only paths with their reason', () => {
    const prompt = buildSplitPrompt({ branch: 'main', hunks: [], wholeFileOnly: [{ path: 'new.txt', status: 'untracked file' }], bodiesIncluded: true });
    expect(prompt).toContain('new.txt');
    expect(prompt).toContain('untracked file');
  });
});

describe('staleSplitPaths', () => {
  it('reports paths whose hash changed and ignores paths not recorded', () => {
    const recorded = { 'a.ts': 'h1', 'b.ts': 'h2' };
    const current = { 'a.ts': 'h1', 'b.ts': 'h2-changed', 'c.ts': 'h3' };
    expect(staleSplitPaths(recorded, current)).toEqual(['b.ts']);
  });
});
