import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

/**
 * Windows a long list of rows inside a scrolling container: only rows that
 * intersect the viewport (plus `overscan` px on each side) are rendered, with
 * spacer heights standing in for the rest. Row heights start from a per-kind
 * estimate and are corrected by measuring rendered rows. Measurements are keyed
 * by `keyOf`, so inserting or removing a row (an inline card, expanded context,
 * another page of commits) keeps every other row's measured height.
 */
export interface RowWindow {
  /** Rendered range is `[start, end)`. */
  start: number;
  end: number;
  /** Heights of the unrendered runs before `start` and after `end`, in px. */
  top: number;
  bottom: number;
  /** Ref callback for the element rendering row `i`; measures it. Stable per index. */
  rowRef: (i: number) => (el: HTMLElement | null) => void;
  /**
   * Scrolls row `i` into view. `center` puts it mid-viewport; `nearest` scrolls only if it is out of view.
   * Renders the target window synchronously and re-aligns as its rows are measured, all before the next paint.
   */
  scrollTo: (i: number, align: 'center' | 'nearest') => void;
}

interface Options {
  count: number;
  /** Row kind, used to share a learned height estimate between rows of the same kind. */
  kindOf: (i: number) => string;
  /** Stable identity of row `i`; a measured height follows its key when rows shift. Must be a new function whenever the rows change. Defaults to the index. */
  keyOf?: (i: number) => string | number;
  /** Initial per-kind height guesses (px) until a row of that kind has been measured. */
  estimates: Record<string, number>;
  /** Changing this discards every measured height (e.g. a new file or a wrap/font change). */
  resetKey: unknown;
  overscan?: number;
}

const DEFAULT_ESTIMATE = 20;
/** Upper bound on scroll/measure passes per scrollTo, in case heights never converge. */
const MAX_SETTLE_PASSES = 8;
const byIndex = (i: number): number => i;

export function useWindowedRows(container: HTMLElement | null, { count, kindOf, keyOf = byIndex, estimates, resetKey, overscan = 600 }: Options): RowWindow {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const measured = useRef(new Map<string | number, number>());
  const offsets = useRef<Float64Array>(new Float64Array(1));
  const kindHeights = useRef<Record<string, number>>({});
  const dirty = useRef(true);
  const scheduled = useRef(false);
  const range = useRef({ start: 0, end: 0 });
  const refCache = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const epoch = useRef(0);
  const lastReset = useRef<unknown>(resetKey);
  /** The current rows, read by ref callbacks and scroll handlers that outlive the render that created them. */
  const rows = useRef({ count, kindOf, keyOf });
  const pending = useRef<{ i: number; align: 'center' | 'nearest'; passes: number } | null>(null);

  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    measured.current.clear();
    refCache.current.clear();
    epoch.current++;
    dirty.current = true;
  }
  if (rows.current.count !== count || rows.current.keyOf !== keyOf) dirty.current = true;
  rows.current = { count, kindOf, keyOf };

  const schedule = () => {
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      rerender();
    });
  };

  const rebuild = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const { count, kindOf, keyOf } = rows.current;
    if (offsets.current.length !== count + 1) offsets.current = new Float64Array(count + 1);
    const off = offsets.current;
    const known = measured.current;
    const learned = kindHeights.current;
    let acc = 0;
    for (let i = 0; i < count; i++) {
      off[i] = acc;
      acc += known.get(keyOf(i)) ?? learned[kindOf(i)] ?? estimates[kindOf(i)] ?? DEFAULT_ESTIMATE;
    }
    off[count] = acc;
  };

  const computeRange = () => {
    rebuild();
    const n = rows.current.count;
    if (!container || n === 0) return { start: 0, end: Math.min(n, 60) };
    return visibleRange(offsets.current, n, container.scrollTop, container.clientHeight, overscan);
  };

  /** Moves the scroll position so row `i` is aligned; returns whether it moved. */
  const align = (el: HTMLElement, i: number, mode: 'center' | 'nearest'): boolean => {
    rebuild();
    const y = offsets.current[i];
    const h = offsets.current[i + 1] - y;
    const before = el.scrollTop;
    let top = before;
    if (mode === 'center') top = Math.max(0, y - (el.clientHeight - h) / 2);
    else if (y < before) top = y;
    else if (y + h > before + el.clientHeight) top = y + h - el.clientHeight;
    el.scrollTop = top;
    return Math.abs(el.scrollTop - before) >= 1;
  };

  useEffect(() => {
    if (!container) return;
    const onScroll = () => {
      const next = computeRange();
      if (next.start !== range.current.start || next.end !== range.current.end) rerender();
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    // A width change re-wraps lines: re-measure everything currently rendered.
    const ro = new ResizeObserver(() => {
      epoch.current++;
      refCache.current.clear();
      rerender();
    });
    ro.observe(container);
    return () => {
      container.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container]);

  const rowRef = useCallback(
    (i: number) => {
      const cache = refCache.current;
      let cb = cache.get(i);
      if (cb) return cb;
      const myEpoch = epoch.current;
      cb = (el: HTMLElement | null) => {
        if (!el || myEpoch !== epoch.current) return;
        const h = el.offsetHeight;
        if (!h) return;
        const { kindOf, keyOf } = rows.current;
        const kind = kindOf(i);
        if (kindHeights.current[kind] === undefined) {
          kindHeights.current[kind] = h;
          dirty.current = true;
        }
        const key = keyOf(i);
        if (measured.current.get(key) !== h) {
          measured.current.set(key, h);
          dirty.current = true;
          schedule();
        }
      };
      cache.set(i, cb);
      return cb;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [epoch.current],
  );

  const scrollTo = useCallback(
    (i: number, mode: 'center' | 'nearest') => {
      if (!container || i < 0 || i >= rows.current.count) return;
      pending.current = { i, align: mode, passes: 0 };
      // Render the target window now: an update from a layout effect or event handler is flushed before paint.
      if (align(container, i, mode)) rerender();
      else pending.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [container],
  );

  // After each commit following a scrollTo, the newly rendered rows have been measured (ref callbacks run
  // before layout effects): re-align with the corrected offsets until the position stops moving.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p || !container) return;
    if (p.i >= rows.current.count || ++p.passes > MAX_SETTLE_PASSES || !align(container, p.i, p.align)) pending.current = null;
    else rerender();
  });

  const { start, end } = computeRange();
  range.current = { start, end };
  // After the first paint the container has a size; recompute once so the initial guess (60 rows) is replaced.
  useLayoutEffect(() => {
    if (container) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container]);

  return { start, end, top: offsets.current[start] ?? 0, bottom: (offsets.current[count] ?? 0) - (offsets.current[end] ?? 0), rowRef, scrollTo };
}

/** Index of the first row whose bottom edge lies below `y` (binary search over cumulative offsets; `offsets[i]` is row i's top, `offsets[count]` the total height). */
function firstRowBelow(offsets: Float64Array, count: number, y: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rows `[start, end)` that intersect `[scrollTop - overscan, scrollTop + viewport + overscan]`. */
export function visibleRange(offsets: Float64Array, count: number, scrollTop: number, viewport: number, overscan: number): { start: number; end: number } {
  const bottom = scrollTop + viewport + overscan;
  const start = firstRowBelow(offsets, count, Math.max(0, scrollTop - overscan));
  let end = firstRowBelow(offsets, count, bottom);
  if (end < count && offsets[end] < bottom) end++;
  return { start, end };
}
