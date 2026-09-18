import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

/**
 * Windows a long list of rows inside a scrolling container: only rows that
 * intersect the viewport (plus `overscan` px on each side) are rendered, with
 * spacer heights standing in for the rest. Row heights start from a per-kind
 * estimate and are corrected by measuring rendered rows, so variable-height
 * rows (wrapped lines, inline cards) settle after their first paint.
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
  /** Scrolls row `i` into view. `center` puts it mid-viewport; `nearest` scrolls only if it is out of view. */
  scrollTo: (i: number, align: 'center' | 'nearest') => void;
}

interface Options {
  count: number;
  /** Row kind, used to share a learned height estimate between rows of the same kind. */
  kindOf: (i: number) => string;
  /** Initial per-kind height guesses (px) until a row of that kind has been measured. */
  estimates: Record<string, number>;
  /** Changing this discards every measured height (e.g. a new file or a wrap/font change). */
  resetKey: unknown;
  overscan?: number;
}

const DEFAULT_ESTIMATE = 20;

export function useWindowedRows(container: HTMLElement | null, { count, kindOf, estimates, resetKey, overscan = 600 }: Options): RowWindow {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const heights = useRef<Float64Array>(new Float64Array(0));
  const measured = useRef<Uint8Array>(new Uint8Array(0));
  const offsets = useRef<Float64Array>(new Float64Array(1));
  const kindHeights = useRef<Record<string, number>>({});
  const dirty = useRef(true);
  const scheduled = useRef(false);
  const range = useRef({ start: 0, end: 0 });
  const refCache = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const epoch = useRef(0);
  const lastReset = useRef<unknown>(resetKey);

  if (lastReset.current !== resetKey || heights.current.length !== count) {
    lastReset.current = resetKey;
    heights.current = new Float64Array(count);
    measured.current = new Uint8Array(count);
    offsets.current = new Float64Array(count + 1);
    dirty.current = true;
    refCache.current.clear();
    epoch.current++;
  }

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
    const h = heights.current;
    const m = measured.current;
    const off = offsets.current;
    const learned = kindHeights.current;
    let acc = 0;
    for (let i = 0; i < count; i++) {
      if (!m[i]) h[i] = learned[kindOf(i)] ?? estimates[kindOf(i)] ?? DEFAULT_ESTIMATE;
      off[i] = acc;
      acc += h[i];
    }
    off[count] = acc;
  };

  const computeRange = () => {
    rebuild();
    if (!container || count === 0) return { start: 0, end: Math.min(count, 60) };
    return visibleRange(offsets.current, count, container.scrollTop, container.clientHeight, overscan);
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
  }, [container, count]);

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
        const kind = kindOf(i);
        if (kindHeights.current[kind] === undefined) {
          kindHeights.current[kind] = h;
          dirty.current = true;
        }
        if (!measured.current[i] || heights.current[i] !== h) {
          heights.current[i] = h;
          measured.current[i] = 1;
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
    (i: number, align: 'center' | 'nearest') => {
      if (!container || i < 0 || i >= count) return;
      rebuild();
      const y = offsets.current[i];
      const h = heights.current[i];
      if (align === 'nearest') {
        if (y >= container.scrollTop && y + h <= container.scrollTop + container.clientHeight) return;
        container.scrollTop = y < container.scrollTop ? y : y + h - container.clientHeight;
        return;
      }
      container.scrollTop = Math.max(0, y - (container.clientHeight - h) / 2);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [container, count],
  );

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
