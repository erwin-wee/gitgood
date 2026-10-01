import type { Commit } from './types';

/**
 * Commit-graph lane layout for the History list.
 *
 * Commits arrive newest-first in a topological order (`git log --date-order`:
 * a parent is never listed before all its children). Each lane waits for one
 * commit sha; a row is drawn in the lane that was waiting for it (or a fresh
 * lane for a branch tip) and hands its lane on to its first parent, while
 * extra (merge) parents get their own lanes. The state carried between rows
 * is just the list of lanes, so a later page continues where the previous one
 * stopped — O(lanes) per commit.
 *
 * Geometry of a row (each row is one fixed-height slot, node at mid-height):
 * - `up`: from the top edge at lane `from` to the node at lane `to`
 * - `down`: from the node at lane `from` to the bottom edge at lane `to`
 * - `through`: a lane passing straight across the row (from === to)
 */
export type GraphSegment = { kind: 'up' | 'down' | 'through'; from: number; to: number; color: number };

export interface GraphRow {
  /** Lane the commit's node sits in. */
  column: number;
  segments: GraphSegment[];
  color: number;
}

/** Color indexes cycle through this many hues. */
export const GRAPH_COLORS = 8;

interface LaneState {
  /** Sha each lane is waiting for; null marks a free lane. */
  ids: (string | null)[];
  colors: number[];
  /** Next color index to hand to a new lane. */
  next: number;
}

export interface Graph {
  rows: GraphRow[];
  /** Widest row, in lanes (max lane index + 1 over every row computed so far). */
  width: number;
  firstSha: string;
  lastSha: string;
  state: LaneState;
}

type GraphCommit = Pick<Commit, 'sha' | 'parents'>;

function step(st: LaneState, { sha, parents }: GraphCommit): { row: GraphRow; width: number } {
  const { ids, colors } = st;
  const segments: GraphSegment[] = [];
  let width = ids.length;
  let column = ids.indexOf(sha);
  let color: number;
  if (column < 0) {
    column = ids.indexOf(null);
    if (column < 0) column = ids.length;
    color = st.next++ % GRAPH_COLORS;
  } else {
    color = colors[column];
  }
  width = Math.max(width, column + 1);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === null) continue;
    if (ids[i] === sha) {
      segments.push({ kind: 'up', from: i, to: column, color: colors[i] });
      ids[i] = null;
    } else {
      segments.push({ kind: 'through', from: i, to: i, color: colors[i] });
    }
  }
  parents.forEach((p, k) => {
    let lane = ids.indexOf(p);
    let segColor = color;
    if (lane >= 0) {
      // Already expected further down by another child: join that lane. A merge-in takes the joined lane's color.
      if (k > 0) segColor = colors[lane];
    } else if (k === 0) {
      lane = column;
      ids[lane] = p;
      colors[lane] = color;
    } else {
      lane = ids.indexOf(null);
      if (lane < 0) lane = ids.length;
      ids[lane] = p;
      colors[lane] = segColor = st.next++ % GRAPH_COLORS;
    }
    width = Math.max(width, lane + 1);
    segments.push({ kind: 'down', from: column, to: lane, color: segColor });
  });
  while (ids.length && ids[ids.length - 1] === null) ids.pop();
  colors.length = ids.length;
  return { row: { column, segments, color }, width };
}

/**
 * Lays out `commits` (the full loaded list, newest first), reusing `prev` when
 * it covers a prefix of the same list — a new page then costs only its own
 * commits. A list that no longer starts the same way is recomputed from
 * scratch. `prev` is never mutated.
 */
export function extendGraph(prev: Graph | null, commits: readonly GraphCommit[]): Graph {
  const done = prev ? prev.rows.length : 0;
  const reusable = !!prev && done > 0 && done <= commits.length && commits[0].sha === prev.firstSha && commits[done - 1].sha === prev.lastSha;
  if (reusable && done === commits.length) return prev!;
  const base = reusable ? prev! : null;
  const state: LaneState = base ? { ids: [...base.state.ids], colors: [...base.state.colors], next: base.state.next } : { ids: [], colors: [], next: 0 };
  const rows = base ? base.rows.slice() : [];
  let width = base ? base.width : 0;
  for (let i = base ? done : 0; i < commits.length; i++) {
    const r = step(state, commits[i]);
    rows.push(r.row);
    if (r.width > width) width = r.width;
  }
  return { rows, width, firstSha: commits.length ? commits[0].sha : '', lastSha: commits.length ? commits[commits.length - 1].sha : '', state };
}
