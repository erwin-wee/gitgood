import { describe, expect, it } from 'vitest';
import { visibleRange } from '../src/renderer/src/lib/windowing';

/** Cumulative tops for rows of the given heights, plus the total as the last entry. */
function offsetsOf(heights: number[]): Float64Array {
  const off = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i++) off[i + 1] = off[i] + heights[i];
  return off;
}

describe('visibleRange', () => {
  it('covers exactly the rows intersecting the viewport plus overscan', () => {
    const off = offsetsOf(new Array(1000).fill(20));
    // Rows 50..59 are on screen (scrollTop 1000, viewport 200); overscan of 100px adds 5 rows each side.
    expect(visibleRange(off, 1000, 1000, 200, 100)).toEqual({ start: 45, end: 65 });
  });

  it('clamps at both ends', () => {
    const off = offsetsOf(new Array(10).fill(20));
    expect(visibleRange(off, 10, 0, 50, 600)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(off, 10, 190, 50, 0)).toEqual({ start: 9, end: 10 });
  });

  it('handles variable heights: a tall card row is included while any part of it is in view', () => {
    const off = offsetsOf([20, 20, 300, 20, 20]);
    // Viewport shows y 330..350: inside row 2 (40..340) and row 3 (340..360).
    expect(visibleRange(off, 5, 330, 20, 0)).toEqual({ start: 2, end: 4 });
  });
});
