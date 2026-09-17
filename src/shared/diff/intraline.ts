/**
 * Word-level diff between a removed line and its paired added line, used to
 * highlight exactly what changed inside a modified line.
 */

export interface CharRange {
  start: number;
  end: number;
}

export interface IntralineResult {
  old: CharRange[];
  new: CharRange[];
}

interface Token {
  text: string;
  start: number;
}

const TOKEN_RE = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g;

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    tokens.push({ text: m[0], start: m.index });
  }
  return tokens;
}

/** Longest common subsequence over token text; returns matched index pairs. */
function lcsPairs(a: Token[], b: Token[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const dp = new Uint16Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i].text === b[j].text) dp[i * w + j] = dp[(i + 1) * w + j + 1] + 1;
      else dp[i * w + j] = Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function rangesFromUnmatched(tokens: Token[], matched: Set<number>, line: string): CharRange[] {
  const ranges: CharRange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (matched.has(i)) continue;
    const t = tokens[i];
    const start = t.start;
    const end = t.start + t.text.length;
    const last = ranges[ranges.length - 1];
    if (last && last.end >= start) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  // Merge ranges separated only by whitespace so highlights read as phrases.
  const merged: CharRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && /^\s*$/.test(line.slice(last.end, r.start)) && r.start - last.end <= 2) {
      last.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Returns highlighted ranges for the old and new lines, or null when the lines
 * are too different for intraline highlighting to be helpful.
 */
export function intralineDiff(oldLine: string, newLine: string): IntralineResult | null {
  if (oldLine === newLine) return { old: [], new: [] };
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length * b.length > 400_000) return null;
  const pairs = lcsPairs(a, b);
  if (pairs.length === 0) return null;
  const matchedA = new Set(pairs.map((p) => p[0]));
  const matchedB = new Set(pairs.map((p) => p[1]));
  const oldRanges = rangesFromUnmatched(a, matchedA, oldLine);
  const newRanges = rangesFromUnmatched(b, matchedB, newLine);
  const changedChars = oldRanges.reduce((s, r) => s + r.end - r.start, 0) + newRanges.reduce((s, r) => s + r.end - r.start, 0);
  const totalChars = oldLine.trim().length + newLine.trim().length;
  // Only whitespace-matched? Treat as too different.
  const matchedNonSpace = pairs.some((p) => a[p[0]].text.trim().length > 0);
  if (!matchedNonSpace) return null;
  if (totalChars > 0 && changedChars / totalChars > 0.7) return null;
  return { old: oldRanges, new: newRanges };
}

/** Splits `text` into segments tagged by whether they fall inside `ranges`. */
export function segmentByRanges(text: string, ranges: CharRange[]): { text: string; changed: boolean }[] {
  if (ranges.length === 0) return [{ text, changed: false }];
  const out: { text: string; changed: boolean }[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start), changed: false });
    out.push({ text: text.slice(r.start, r.end), changed: true });
    pos = r.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), changed: false });
  return out.filter((s) => s.text.length > 0);
}
