/**
 * Pure helpers for the AI rebase assistant ("Tidy up branch with AI"):
 * validating the model's proposed todo list against the real commit range,
 * repairing it into a safe, complete plan, computing the drop/reword/
 * reorder/squash execution order, the minimal set of reorder moves, and the
 * commit-identity remapping used between apply steps. No Electron or Node
 * imports so this can be unit tested and reasoned about in isolation
 * (mirrors the pattern in src/main/ai/review-core.ts).
 */
import type { RebasePlanAction, RebasePlanRow } from '@shared/types';

export const REBASE_MAX_COMMITS = 60;
export const REBASE_MAX_PATCH_BYTES_PER_COMMIT = 8_000;
export const REBASE_MAX_TOTAL_PATCH_BYTES = 120_000;
export const REBASE_MAX_SUMMARY_CHARS = 120;
export const REBASE_BODY_WRAP_COLUMN = 72;
export const REBASE_MAX_RATIONALE_CHARS = 300;

const ACTIONS: RebasePlanAction[] = ['pick', 'squash', 'reword', 'drop'];

// ---------------------------------------------------------------------------
// Input caps: how much of the range is sent to the model
// ---------------------------------------------------------------------------

/** Caps the (oldest-first) commit list sent to the model at REBASE_MAX_COMMITS; anything beyond that is left out of the prompt entirely and picked up later as an "omitted commit" (defaulted to pick in its original position). */
export function capCommitsForPlanning<T>(commits: readonly T[], max = REBASE_MAX_COMMITS): { included: T[]; truncated: boolean } {
  return { included: commits.slice(0, max), truncated: commits.length > max };
}

/** Given each included commit's patch byte size (oldest first), decides which ones fit under the total budget; later commits are dropped to stat-only once the budget is used up. */
export function budgetCommitPatches(commits: readonly { sha: string; patchBytes: number }[], maxTotalBytes = REBASE_MAX_TOTAL_PATCH_BYTES): { includePatch: Set<string>; truncated: boolean } {
  let used = 0;
  const includePatch = new Set<string>();
  let truncated = false;
  for (const c of commits) {
    if (used + c.patchBytes <= maxTotalBytes) {
      includePatch.add(c.sha);
      used += c.patchBytes;
    } else {
      truncated = true;
    }
  }
  return { includePatch, truncated };
}

// ---------------------------------------------------------------------------
// Message formatting: trailer preservation, summary/body caps
// ---------------------------------------------------------------------------

const TRAILER_LINE = /^[A-Za-z-]+: .+$/;

/** Trailer lines (e.g. "Co-authored-by: ...") at the very end of a message, in order. */
export function extractTrailers(message: string): string[] {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const trailers: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') {
      if (trailers.length) break;
      continue;
    }
    if (TRAILER_LINE.test(line)) trailers.unshift(line);
    else break;
  }
  return trailers;
}

/** Re-appends any of `originalMessage`'s trailing trailer lines that are missing from `message`. */
export function ensureTrailers(message: string, originalMessage: string): string {
  const original = extractTrailers(originalMessage);
  if (!original.length) return message;
  const current = extractTrailers(message);
  const missing = original.filter((t) => !current.includes(t));
  if (!missing.length) return message;
  const base = message.trimEnd();
  return base ? `${base}\n\n${missing.join('\n')}` : missing.join('\n');
}

function wrapBody(body: string, column = REBASE_BODY_WRAP_COLUMN): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (line.length <= column || TRAILER_LINE.test(line.trim())) return line;
      const words = line.split(' ');
      const out: string[] = [];
      let cur = '';
      for (const w of words) {
        if (cur && (cur + ' ' + w).length > column) {
          out.push(cur);
          cur = w;
        } else {
          cur = cur ? `${cur} ${w}` : w;
        }
      }
      if (cur) out.push(cur);
      return out.join('\n');
    })
    .join('\n');
}

/** Caps the summary line at REBASE_MAX_SUMMARY_CHARS and wraps the body at REBASE_BODY_WRAP_COLUMN, preserving trailers unwrapped. */
export function formatRebaseMessage(message: string): string {
  const normalized = message.replace(/\r\n/g, '\n').trim();
  const [firstLine, ...rest] = normalized.split('\n');
  const summary = firstLine.length > REBASE_MAX_SUMMARY_CHARS ? firstLine.slice(0, REBASE_MAX_SUMMARY_CHARS).trimEnd() : firstLine;
  const body = rest.join('\n').trim();
  if (!body) return summary;
  return `${summary}\n\n${wrapBody(body)}`;
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

export interface OriginalCommitInfo {
  sha: string;
  authorDate: string;
  /** Full message: summary + blank line + body, trimmed. */
  message: string;
  pushed: boolean;
  isEmpty: boolean;
  /** sha of another commit in range this one is an exact revert pair with, or null. */
  revertPairSha: string | null;
}

interface RawRebaseRow {
  sha?: unknown;
  action?: unknown;
  squashInto?: unknown;
  message?: unknown;
  rationale?: unknown;
}

export interface RebasePlanValidationResult {
  rows: RebasePlanRow[];
  warnings: string[];
  alreadyTidy: boolean;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Validates the model's raw `{ rows: [...] }` output against the real
 * commit range: completeness (every original commit appears exactly once,
 * omissions added as pick in original position), duplicates and unknown
 * shas dropped, squash target rules (must be an earlier pick/reword row),
 * trailer preservation, drop downgrade (unless empty or an exact revert
 * pair), and message formatting caps. Never trusts the model's ordering,
 * action or message without checking it against `originalCommits`.
 */
export function validateRebasePlan(raw: unknown, originalCommits: readonly OriginalCommitInfo[]): RebasePlanValidationResult {
  const warnings: string[] = [];
  const originalBySha = new Map(originalCommits.map((c) => [c.sha, c]));
  const originalOrder = originalCommits.map((c) => c.sha);

  const rawRows = raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows) ? ((raw as { rows: unknown[] }).rows as RawRebaseRow[]) : [];

  interface Tentative {
    sha: string;
    action: RebasePlanAction;
    squashInto: string | null;
    message: string;
    rationale: string;
  }

  const tentativeBySha = new Map<string, Tentative>();
  const modelOrder: string[] = [];
  for (const r of rawRows) {
    const sha = asString(r.sha);
    const original = originalBySha.get(sha);
    if (!original) {
      if (sha) warnings.push(`Unknown commit "${sha.slice(0, 12)}" in the model's plan was dropped.`);
      continue;
    }
    if (tentativeBySha.has(sha)) {
      warnings.push(`Commit ${sha.slice(0, 7)} appeared more than once in the model's plan; the first entry was kept.`);
      continue;
    }
    const action = ACTIONS.includes(r.action as RebasePlanAction) ? (r.action as RebasePlanAction) : 'pick';
    const squashInto = action === 'squash' && typeof r.squashInto === 'string' ? r.squashInto : null;
    const rawMessage = asString(r.message).trim();
    const message = action === 'drop' ? original.message : rawMessage || original.message;
    const rationale = asString(r.rationale).trim().slice(0, REBASE_MAX_RATIONALE_CHARS);
    tentativeBySha.set(sha, { sha, action, squashInto, message, rationale });
    modelOrder.push(sha);
  }

  // Completeness: interleave commits the model omitted at their original position relative to
  // the previous original commit (which is always already placed by the time we reach it, since
  // we walk originalCommits oldest-first and every earlier one was either in the model's rows or
  // inserted in an earlier iteration of this loop).
  const outputOrder = [...modelOrder];
  const consumed = new Set(modelOrder);
  originalCommits.forEach((oc, idx) => {
    if (consumed.has(oc.sha)) return;
    if (idx === 0) {
      outputOrder.unshift(oc.sha);
    } else {
      const prevSha = originalCommits[idx - 1].sha;
      const pos = outputOrder.indexOf(prevSha);
      outputOrder.splice(pos + 1, 0, oc.sha);
    }
    consumed.add(oc.sha);
    tentativeBySha.set(oc.sha, { sha: oc.sha, action: 'pick', squashInto: null, message: oc.message, rationale: '' });
  });

  // Squash target validation: must reference an earlier row (lower index in the final order) whose
  // own action is pick or reword — never a dropped or itself-squashed row.
  const indexOf = new Map(outputOrder.map((sha, i) => [sha, i]));
  for (const sha of outputOrder) {
    const t = tentativeBySha.get(sha)!;
    if (t.action !== 'squash') continue;
    const target = t.squashInto ? tentativeBySha.get(t.squashInto) : null;
    const targetOk = !!target && (target.action === 'pick' || target.action === 'reword') && (indexOf.get(target.sha) ?? Infinity) < (indexOf.get(sha) ?? -1);
    if (!targetOk) {
      warnings.push(`Commit ${sha.slice(0, 7)} squashed into an invalid target; it was kept as a separate commit instead.`);
      t.action = 'pick';
      t.squashInto = null;
    }
  }

  // Drop downgrade: only an empty commit or one half of an exact revert pair may be dropped.
  for (const sha of outputOrder) {
    const t = tentativeBySha.get(sha)!;
    if (t.action !== 'drop') continue;
    const original = originalBySha.get(sha)!;
    if (!original.isEmpty && !original.revertPairSha) {
      warnings.push(`Commit ${sha.slice(0, 7)} is not empty and is not part of an exact revert pair; it was kept instead of dropped.`);
      t.action = 'pick';
    }
  }

  // Trailer preservation + message formatting caps (skip drop rows, whose message is unused).
  for (const sha of outputOrder) {
    const t = tentativeBySha.get(sha)!;
    if (t.action === 'drop') continue;
    const original = originalBySha.get(sha)!;
    t.message = formatRebaseMessage(ensureTrailers(t.message, original.message));
  }

  const rows: RebasePlanRow[] = outputOrder.map((sha) => {
    const t = tentativeBySha.get(sha)!;
    const original = originalBySha.get(sha)!;
    return { sha, action: t.action, squashInto: t.squashInto, originalMessage: original.message, message: t.message, rationale: t.rationale, pushed: original.pushed };
  });

  const sameOrder = outputOrder.length === originalOrder.length && outputOrder.every((sha, i) => sha === originalOrder[i]);
  const alreadyTidy = sameOrder && rows.every((r) => r.action === 'pick' && r.message === r.originalMessage);

  return { rows, warnings, alreadyTidy };
}

// ---------------------------------------------------------------------------
// Execution ordering: drops -> rewords -> reorders -> squashes
// ---------------------------------------------------------------------------

export interface ReorderMove {
  /** Original shas to move together, in their relative order. */
  shas: string[];
  /** Original sha to move `shas` to immediately after (in oldest-first order); null moves them to the tip (newest). */
  anchor: string | null;
}

/**
 * Computes the minimal sequence of "move group to after anchor" operations
 * (matching `reorderCommits`'s semantics: shas are moved to immediately
 * after `anchor` in oldest-first order, i.e. visually before it in a
 * newest-first history view) that transforms `current` into `desired`.
 * Both arrays must contain the same set of ids. Each iteration fixes at
 * least one more position: for a mismatch at the very front, the whole
 * misplaced prefix is moved after the correct element instead (there is no
 * "move to the oldest position" primitive); otherwise the single correct
 * element is moved to just after the previous, already-correct element.
 */
export function computeReorderMoves(current: readonly string[], desired: readonly string[]): ReorderMove[] {
  const cur = [...current];
  const moves: ReorderMove[] = [];
  for (let i = 0; i < desired.length; i++) {
    if (cur[i] === desired[i]) continue;
    const x = desired[i];
    const j = cur.indexOf(x);
    if (j === -1) continue; // should not happen when the sets match; defensive no-op
    if (i === 0) {
      const group = cur.slice(0, j);
      moves.push({ shas: group, anchor: x });
      cur.splice(0, j);
      cur.splice(1, 0, ...group);
    } else {
      const anchor = cur[i - 1];
      cur.splice(j, 1);
      const anchorPos = cur.indexOf(anchor);
      cur.splice(anchorPos + 1, 0, x);
      moves.push({ shas: [x], anchor });
    }
  }
  return moves;
}

export interface SquashGroup {
  targetSha: string;
  fixupShas: string[];
  message: string;
}

export interface RebaseExecutionPlan {
  /** Original shas to drop, oldest first. */
  drops: string[];
  /** Rewords to apply (by original sha), in row order. */
  rewords: { sha: string; message: string }[];
  reorderMoves: ReorderMove[];
  /** Squash groups (target + its fixups), in the desired (post-reorder) order of their targets. */
  squashGroups: SquashGroup[];
}

/** Builds the ordered execution plan (drops, then rewords, then reorders, then squashes) from the validated rows and the true original chronological order. */
export function buildExecutionPlan(originalOrder: readonly string[], rows: readonly RebasePlanRow[]): RebaseExecutionPlan {
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const drops = originalOrder.filter((sha) => bySha.get(sha)?.action === 'drop');
  const survivorsOriginalOrder = originalOrder.filter((sha) => bySha.get(sha)?.action !== 'drop');
  const desiredOrder = rows.filter((r) => r.action !== 'drop').map((r) => r.sha);
  const reorderMoves = computeReorderMoves(survivorsOriginalOrder, desiredOrder);
  const rewords = rows.filter((r) => r.action === 'reword').map((r) => ({ sha: r.sha, message: r.message }));

  const fixupsByTarget = new Map<string, string[]>();
  for (const r of rows) {
    if (r.action === 'squash' && r.squashInto) fixupsByTarget.set(r.squashInto, [...(fixupsByTarget.get(r.squashInto) ?? []), r.sha]);
  }
  const squashGroups: SquashGroup[] = [];
  for (const sha of desiredOrder) {
    const fixups = fixupsByTarget.get(sha);
    if (!fixups?.length) continue;
    squashGroups.push({ targetSha: sha, fixupShas: fixups, message: bySha.get(sha)!.message });
  }

  return { drops, rewords, reorderMoves, squashGroups };
}

// ---------------------------------------------------------------------------
// SHA remapping between apply steps
// ---------------------------------------------------------------------------

export interface TrackedCommit {
  /** Stable identity: the commit's original sha at plan time. */
  id: string;
  authorDate: string;
  message: string;
}

export interface LiveCommit {
  sha: string;
  authorDate: string;
  message: string;
}

/**
 * Matches tracked identities to their current live sha after a rewriting
 * step, by (author date, full message); falls back to pairing by position
 * (tracked[i] <-> live[i]) for any identity that could not be matched
 * uniquely, or when the whole set does not overlap cleanly (e.g. two
 * commits share the same author date and message). Returns null when the
 * counts differ, which the caller treats as unrecoverable and aborts to the
 * recorded start commit.
 */
export function remapShas(tracked: readonly TrackedCommit[], live: readonly LiveCommit[]): Map<string, string> | null {
  if (tracked.length !== live.length) return null;
  const map = new Map<string, string>();
  const usedLive = new Set<number>();
  for (const t of tracked) {
    const idx = live.findIndex((l, i) => !usedLive.has(i) && l.authorDate === t.authorDate && l.message === t.message);
    if (idx !== -1) {
      usedLive.add(idx);
      map.set(t.id, live[idx].sha);
    }
  }
  tracked.forEach((t, i) => {
    if (!map.has(t.id)) map.set(t.id, live[i].sha);
  });
  return map;
}
