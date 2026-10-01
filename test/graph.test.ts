import { describe, expect, it } from 'vitest';
import { extendGraph, type Graph } from '../src/shared/graph';

const c = (sha: string, ...parents: string[]) => ({ sha, parents });
const seg = (g: Graph, i: number) => g.rows[i].segments.map((s) => `${s.kind}:${s.from}>${s.to}`);

describe('commit graph lanes', () => {
  it('keeps a linear history in lane 0 with a single colour', () => {
    const g = extendGraph(null, [c('c', 'b'), c('b', 'a'), c('a')]);
    expect(g.rows.map((r) => r.column)).toEqual([0, 0, 0]);
    expect(new Set(g.rows.map((r) => r.color)).size).toBe(1);
    expect(g.width).toBe(1);
    expect(seg(g, 0)).toEqual(['down:0>0']);
    expect(seg(g, 1)).toEqual(['up:0>0', 'down:0>0']);
    expect(seg(g, 2)).toEqual(['up:0>0']); // root: line ends at the node
  });

  it('opens a lane for the merged branch, passes it through, and closes it at the fork point', () => {
    // m merges feature tip f2 into main; both descend from base b.
    const g = extendGraph(null, [c('m', 'p', 'f2'), c('p', 'b'), c('f2', 'f1'), c('f1', 'b'), c('b')]);
    expect(g.rows.map((r) => r.column)).toEqual([0, 0, 1, 1, 0]);
    expect(seg(g, 0)).toEqual(['down:0>0', 'down:0>1']);
    expect(seg(g, 1)).toEqual(['up:0>0', 'through:1>1', 'down:0>0']);
    expect(seg(g, 2)).toEqual(['through:0>0', 'up:1>1', 'down:1>1']);
    // f1's first parent b is already expected in lane 0: the branch line bends into it.
    expect(seg(g, 3)).toEqual(['through:0>0', 'up:1>1', 'down:1>0']);
    expect(seg(g, 4)).toEqual(['up:0>0']);
    expect(g.rows[2].color).not.toBe(g.rows[0].color);
    expect(g.width).toBe(2);
  });

  it('gives every extra parent of an octopus merge its own lane', () => {
    const g = extendGraph(null, [c('o', 'a', 'b', 'd'), c('a'), c('b'), c('d')]);
    expect(seg(g, 0)).toEqual(['down:0>0', 'down:0>1', 'down:0>2']);
    expect(g.rows.map((r) => r.column)).toEqual([0, 0, 1, 2]);
    expect(new Set(g.rows[0].segments.map((s) => s.color)).size).toBe(3);
    expect(g.width).toBe(3);
    // Each root closes its own lane; lanes it does not own pass through.
    expect(seg(g, 2)).toEqual(['up:1>1', 'through:2>2']);
  });

  it('draws two tips converging on a shared parent and reuses freed lanes', () => {
    const g = extendGraph(null, [c('x', 'base'), c('y', 'base'), c('base'), c('z')]);
    expect(g.rows.map((r) => r.column)).toEqual([0, 1, 0, 0]);
    expect(seg(g, 1)).toEqual(['through:0>0', 'down:1>0']);
    expect(seg(g, 2)).toEqual(['up:0>0']); // both lanes merged: nothing passes below
    expect(g.width).toBe(2);
    // z is a fresh tip after everything closed: it starts in the freed lane 0.
    expect(seg(g, 3)).toEqual([]);
  });

  it('continues across pages exactly as a single pass would, without mutating the previous graph', () => {
    const all = [c('m', 'p', 'f2'), c('p', 'b'), c('f2', 'f1'), c('f1', 'b'), c('b', 'a'), c('a')];
    const page1 = extendGraph(null, all.slice(0, 3));
    const frozen = JSON.stringify(page1);
    const both = extendGraph(page1, all);
    expect(JSON.stringify(page1)).toBe(frozen);
    expect(both.rows).toEqual(extendGraph(null, all).rows);
    // The first page's rows are reused, not recomputed.
    expect(both.rows[0]).toBe(page1.rows[0]);
    // Nothing new: same object back.
    expect(extendGraph(both, all)).toBe(both);
  });

  it('leaves dangling lanes open at a page boundary and picks them up on the next page', () => {
    const page1 = extendGraph(null, [c('m', 'p', 'f2'), c('p', 'b')]);
    expect(page1.state.ids).toEqual(['b', 'f2']);
    const page2 = extendGraph(page1, [c('m', 'p', 'f2'), c('p', 'b'), c('f2', 'f1')]);
    expect(seg(page2, 2)).toEqual(['through:0>0', 'up:1>1', 'down:1>1']);
  });

  it('recomputes when the list no longer extends the previous one', () => {
    const before = extendGraph(null, [c('b', 'a'), c('a')]);
    const after = extendGraph(before, [c('n', 'b'), c('b', 'a'), c('a')]);
    expect(after.rows).toHaveLength(3);
    expect(after.firstSha).toBe('n');
    expect(extendGraph(before, []).rows).toEqual([]);
  });

  it('stays linear-time on a long history with a long-lived side branch', () => {
    const commits = [];
    for (let i = 20000; i > 0; i--) commits.push(c(`m${i}`, `m${i - 1}`));
    commits.splice(100, 0, c('side', 'm5'));
    commits[99] = c('m19901', 'm19900', 'side');
    const start = performance.now();
    const g = extendGraph(null, commits);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(g.width).toBe(2);
  });
});
