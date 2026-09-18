import { describe, expect, it } from 'vitest';
import {
  buildExecutionPlan,
  budgetCommitPatches,
  capCommitsForPlanning,
  computeReorderMoves,
  ensureTrailers,
  extractTrailers,
  formatRebaseMessage,
  REBASE_MAX_COMMITS,
  remapShas,
  validateRebasePlan,
  type OriginalCommitInfo,
} from '../src/main/ai/rebase-plan-core';

let dateSeq = 0;
function original(sha: string, message: string, opts: Partial<OriginalCommitInfo> = {}): OriginalCommitInfo {
  dateSeq++;
  return { sha, authorDate: `2024-01-01T00:${String(dateSeq).padStart(2, '0')}:00Z`, message, pushed: false, isEmpty: false, revertPairSha: null, ...opts };
}

describe('rebase-plan-core: input caps', () => {
  it('caps the commit list sent to the model at REBASE_MAX_COMMITS', () => {
    const commits = Array.from({ length: 90 }, (_, i) => ({ sha: `s${i}` }));
    const { included, truncated } = capCommitsForPlanning(commits);
    expect(included).toHaveLength(REBASE_MAX_COMMITS);
    expect(truncated).toBe(true);
    const small = capCommitsForPlanning(commits.slice(0, 10));
    expect(small.truncated).toBe(false);
    expect(small.included).toHaveLength(10);
  });

  it('budgets per-commit patches against a total byte cap', () => {
    const commits = [
      { sha: 'a', patchBytes: 50_000 },
      { sha: 'b', patchBytes: 50_000 },
      { sha: 'c', patchBytes: 50_000 },
    ];
    const { includePatch, truncated } = budgetCommitPatches(commits, 120_000);
    expect(includePatch.has('a')).toBe(true);
    expect(includePatch.has('b')).toBe(true);
    expect(includePatch.has('c')).toBe(false);
    expect(truncated).toBe(true);
  });
});

describe('rebase-plan-core: message formatting', () => {
  it('preserves trailers missing from a reworded message', () => {
    const original = 'wip\n\nCo-authored-by: Jane Doe <jane@example.com>';
    const reworded = 'Add retry to fetch queue';
    expect(ensureTrailers(reworded, original)).toBe('Add retry to fetch queue\n\nCo-authored-by: Jane Doe <jane@example.com>');
    // Already present: unchanged.
    const alreadyThere = 'Add retry\n\nCo-authored-by: Jane Doe <jane@example.com>';
    expect(ensureTrailers(alreadyThere, original)).toBe(alreadyThere);
  });

  it('extracts only trailing trailer-shaped lines', () => {
    expect(extractTrailers('Summary\n\nBody: not a trailer really\nCo-authored-by: A <a@b.com>')).toEqual(['Body: not a trailer really', 'Co-authored-by: A <a@b.com>']);
    expect(extractTrailers('Just a summary')).toEqual([]);
  });

  it('caps the summary line and wraps the body', () => {
    const long = 'x'.repeat(200);
    const capped = formatRebaseMessage(long);
    expect(capped.length).toBe(120);
    const wrapped = formatRebaseMessage(`Summary\n\n${'word '.repeat(30).trim()}`);
    expect(wrapped.split('\n').every((l) => l.length <= 72)).toBe(true);
  });
});

describe('rebase-plan-core: validateRebasePlan', () => {
  const range: OriginalCommitInfo[] = [original('aaa1', 'base work'), original('aaa2', 'wip'), original('aaa3', 'fix typo')];

  it('keeps a valid model plan as-is', () => {
    const raw = { rows: [{ sha: 'aaa1', action: 'pick', squashInto: null, message: 'base work', rationale: '' }, { sha: 'aaa2', action: 'squash', squashInto: 'aaa1', message: 'base work', rationale: 'fixup' }, { sha: 'aaa3', action: 'squash', squashInto: 'aaa1', message: 'base work', rationale: 'fixup' }] };
    const { rows, warnings } = validateRebasePlan(raw, range);
    expect(warnings).toHaveLength(0);
    expect(rows.map((r) => r.action)).toEqual(['pick', 'squash', 'squash']);
  });

  it('adds an omitted commit as pick in its original position', () => {
    const raw = { rows: [{ sha: 'aaa1', action: 'pick', squashInto: null, message: 'base work', rationale: '' }, { sha: 'aaa3', action: 'reword', squashInto: null, message: 'Fix typo', rationale: '' }] };
    const { rows, warnings } = validateRebasePlan(raw, range);
    expect(rows.map((r) => r.sha)).toEqual(['aaa1', 'aaa2', 'aaa3']);
    expect(rows[1]).toMatchObject({ action: 'pick', sha: 'aaa2' });
    expect(warnings).toHaveLength(0);
  });

  it('drops duplicate and unknown commits with a warning', () => {
    const raw = {
      rows: [
        { sha: 'aaa1', action: 'pick', squashInto: null, message: 'base work', rationale: '' },
        { sha: 'aaa1', action: 'drop', squashInto: null, message: '', rationale: '' },
        { sha: 'zzz9', action: 'pick', squashInto: null, message: 'nope', rationale: '' },
        { sha: 'aaa2', action: 'pick', squashInto: null, message: 'wip', rationale: '' },
        { sha: 'aaa3', action: 'pick', squashInto: null, message: 'fix typo', rationale: '' },
      ],
    };
    const { rows, warnings } = validateRebasePlan(raw, range);
    expect(rows).toHaveLength(3);
    expect(warnings.some((w) => w.includes('more than once'))).toBe(true);
    expect(warnings.some((w) => w.includes('Unknown commit'))).toBe(true);
  });

  it('downgrades a squash into a later or dropped row to pick', () => {
    const raw = {
      rows: [
        { sha: 'aaa1', action: 'squash', squashInto: 'aaa2', message: '', rationale: '' }, // later row: invalid
        { sha: 'aaa2', action: 'pick', squashInto: null, message: 'wip', rationale: '' },
        { sha: 'aaa3', action: 'squash', squashInto: 'aaa1', message: 'x', rationale: '' }, // aaa1 ends up pick, so this is actually valid (earlier, pick)
      ],
    };
    const { rows, warnings } = validateRebasePlan(raw, range);
    expect(rows.find((r) => r.sha === 'aaa1')!.action).toBe('pick');
    expect(warnings.some((w) => w.includes('invalid target'))).toBe(true);
    expect(rows.find((r) => r.sha === 'aaa3')!.action).toBe('squash');
  });

  it('downgrades a drop of a non-empty, non-revert commit to pick with a warning', () => {
    const raw = { rows: [{ sha: 'aaa1', action: 'pick', squashInto: null, message: 'base work', rationale: '' }, { sha: 'aaa2', action: 'drop', squashInto: null, message: '', rationale: '' }, { sha: 'aaa3', action: 'pick', squashInto: null, message: 'fix typo', rationale: '' }] };
    const { rows, warnings } = validateRebasePlan(raw, range);
    expect(rows.find((r) => r.sha === 'aaa2')!.action).toBe('pick');
    expect(warnings.some((w) => w.includes('not empty'))).toBe(true);
  });

  it('allows dropping an empty commit or an exact revert pair', () => {
    const withEmpty: OriginalCommitInfo[] = [original('aaa1', 'base'), original('aaa2', 'empty', { isEmpty: true }), original('aaa3', 'keep')];
    const raw = { rows: [{ sha: 'aaa1', action: 'pick', squashInto: null, message: 'base', rationale: '' }, { sha: 'aaa2', action: 'drop', squashInto: null, message: '', rationale: '' }, { sha: 'aaa3', action: 'pick', squashInto: null, message: 'keep', rationale: '' }] };
    const { rows, warnings } = validateRebasePlan(raw, withEmpty);
    expect(rows.find((r) => r.sha === 'aaa2')!.action).toBe('drop');
    expect(warnings).toHaveLength(0);
  });

  it('reports nothing-to-do when every row is pick, unchanged, in order', () => {
    const raw = { rows: range.map((c) => ({ sha: c.sha, action: 'pick', squashInto: null, message: c.message, rationale: '' })) };
    const { alreadyTidy, originalOrder } = validateRebasePlan(raw, range);
    expect(alreadyTidy).toBe(true);
    // The renderer recomputes "already tidy" after local edits and needs the
    // pre-plan order to do it, so the plan has to carry it.
    expect(originalOrder).toEqual(['aaa1', 'aaa2', 'aaa3']);
  });

  it('is not tidy when the plan only reorders', () => {
    const reordered = [range[2], range[0], range[1]];
    const raw = { rows: reordered.map((c) => ({ sha: c.sha, action: 'pick', squashInto: null, message: c.message, rationale: '' })) };
    const { alreadyTidy, rows, originalOrder } = validateRebasePlan(raw, range);
    expect(alreadyTidy).toBe(false);
    expect(rows.map((r) => r.sha)).toEqual(['aaa3', 'aaa1', 'aaa2']);
    expect(originalOrder).toEqual(['aaa1', 'aaa2', 'aaa3']);
  });

  it('preserves issue references and trailers through a reword', () => {
    const withTrailer: OriginalCommitInfo[] = [original('aaa1', 'wip fixes #42\n\nSigned-off-by: Dev <dev@example.com>')];
    const raw = { rows: [{ sha: 'aaa1', action: 'reword', squashInto: null, message: 'Fix the retry loop', rationale: '' }] };
    const { rows } = validateRebasePlan(raw, withTrailer);
    expect(rows[0].message).toContain('Signed-off-by: Dev <dev@example.com>');
  });
});

describe('rebase-plan-core: computeReorderMoves', () => {
  it('produces no moves when already in order', () => {
    expect(computeReorderMoves(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('computes moves that transform current into desired (single swap)', () => {
    const moves = computeReorderMoves(['a', 'b', 'c'], ['b', 'a', 'c']);
    expect(moves).toEqual([{ shas: ['a'], anchor: 'b' }]);
  });

  it('computes moves for a full reversal and actually reaches the desired order when simulated', () => {
    function simulate(current: string[], moves: { shas: string[]; anchor: string | null }[]): string[] {
      let cur = [...current];
      for (const m of moves) {
        cur = cur.filter((x) => !m.shas.includes(x));
        if (m.anchor === null) cur = [...cur, ...m.shas];
        else {
          const idx = cur.indexOf(m.anchor);
          cur = [...cur.slice(0, idx + 1), ...m.shas, ...cur.slice(idx + 1)];
        }
      }
      return cur;
    }
    const current = ['a', 'b', 'c', 'd'];
    const desired = ['d', 'c', 'b', 'a'];
    const moves = computeReorderMoves(current, desired);
    expect(simulate(current, moves)).toEqual(desired);
  });

  it('handles an element moving to the very end', () => {
    const current = ['a', 'b', 'c'];
    const desired = ['b', 'c', 'a'];
    const moves = computeReorderMoves(current, desired);
    function simulate(cur0: string[]): string[] {
      let cur = [...cur0];
      for (const m of moves) {
        cur = cur.filter((x) => !m.shas.includes(x));
        if (m.anchor === null) cur = [...cur, ...m.shas];
        else {
          const idx = cur.indexOf(m.anchor);
          cur = [...cur.slice(0, idx + 1), ...m.shas, ...cur.slice(idx + 1)];
        }
      }
      return cur;
    }
    expect(simulate(current)).toEqual(desired);
  });
});

describe('rebase-plan-core: buildExecutionPlan', () => {
  it('orders drops, rewords, reorders, squashes', () => {
    const rows = [
      { sha: 'a', action: 'pick' as const, squashInto: null, originalMessage: 'a', message: 'a', rationale: '', pushed: false },
      { sha: 'c', action: 'reword' as const, squashInto: null, originalMessage: 'c', message: 'C reworded', rationale: '', pushed: false },
      { sha: 'd', action: 'squash' as const, squashInto: 'a', originalMessage: 'd', message: 'a', rationale: '', pushed: false },
    ];
    const originalOrder = ['a', 'b', 'c', 'd'];
    const rowsWithDrop = [{ sha: 'b', action: 'drop' as const, squashInto: null, originalMessage: 'b', message: 'b', rationale: '', pushed: false }, ...rows];
    const exec = buildExecutionPlan(originalOrder, rowsWithDrop);
    expect(exec.drops).toEqual(['b']);
    expect(exec.rewords).toEqual([{ sha: 'c', message: 'C reworded' }]);
    expect(exec.squashGroups).toEqual([{ targetSha: 'a', fixupShas: ['d'], message: 'a' }]);
    // desired order (non-dropped, in row order) is a, c, d; original survivors are a, c, d too (b removed) -> no reorder needed
    expect(exec.reorderMoves).toEqual([]);
  });
});

describe('rebase-plan-core: remapShas', () => {
  it('matches by author date and message', () => {
    const tracked = [
      { id: 'orig1', authorDate: '2024-01-01T00:00:00Z', message: 'base' },
      { id: 'orig2', authorDate: '2024-01-02T00:00:00Z', message: 'feature' },
    ];
    const live = [
      { sha: 'live1', authorDate: '2024-01-01T00:00:00Z', message: 'base' },
      { sha: 'live2', authorDate: '2024-01-02T00:00:00Z', message: 'feature' },
    ];
    const map = remapShas(tracked, live);
    expect(map?.get('orig1')).toBe('live1');
    expect(map?.get('orig2')).toBe('live2');
  });

  it('falls back to position when content does not match uniquely', () => {
    const tracked = [
      { id: 'orig1', authorDate: '2024-01-01T00:00:00Z', message: 'wip' },
      { id: 'orig2', authorDate: '2024-01-01T00:00:00Z', message: 'wip' },
    ];
    const live = [
      { sha: 'live1', authorDate: '2024-01-01T00:00:00Z', message: 'wip' },
      { sha: 'live2', authorDate: '2024-01-01T00:00:00Z', message: 'wip' },
    ];
    const map = remapShas(tracked, live);
    expect(map?.get('orig1')).toBe('live1');
    expect(map?.get('orig2')).toBe('live2');
  });

  it('returns null when counts differ', () => {
    expect(remapShas([{ id: 'a', authorDate: '1', message: 'm' }], [])).toBeNull();
  });
});
