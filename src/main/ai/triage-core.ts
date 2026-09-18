/**
 * Pure helpers for AI pull request triage: the deterministic state rules
 * that run before and after the model call, validation of the model's batch
 * output against the pull requests it was asked about, batching and cache
 * eviction. No Electron or Node imports so this can be unit tested and
 * reasoned about in isolation (see review-core.ts for the sibling pattern
 * used by the AI pull request reviewer).
 */
import type { PrTriage, PullRequest, TriageNextAction, TriageState } from '@shared/types';

export const MAX_SUMMARY_CHARS = 140;
export const MAX_REASON_CHARS = 200;
export const BATCH_SIZE = 15;
export const STALE_DAYS = 14;
export const CACHE_MAX_AGE_DAYS = 30;

const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const CACHE_MAX_AGE_MS = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const TRIAGE_STATES: TriageState[] = ['waiting-on-you', 'waiting-on-author', 'waiting-on-others', 'checks-failing', 'ready-to-merge', 'draft', 'stale', 'conflicts'];
const TRIAGE_NEXT_ACTIONS: TriageNextAction[] = ['review', 'checkout', 'view-checks', 'merge', 'rebase', 'ping-author', 'none'];

/**
 * Deterministic state the code is confident about for this pull request, or
 * null when the metadata is not decisive and the model's own judgement
 * should stand. Applied both before the model call (to skip PRs whose state
 * is already known) and after it (to override a contradicting answer) — see
 * design.md decision 2. Rules are checked in the order listed in the spec;
 * the first that matches wins.
 */
export function classifyTriageState(pr: PullRequest, login: string | null, now: number): TriageState | null {
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING') return 'conflicts';
  const isOwn = !!login && pr.author.toLowerCase() === login.toLowerCase();
  if (isOwn && pr.checks.state === 'failure') return 'waiting-on-author';
  if (login && pr.reviewRequests.some((r) => r.toLowerCase() === login.toLowerCase())) return 'waiting-on-you';
  const updated = Date.parse(pr.updatedAt);
  if (!Number.isNaN(updated) && now - updated >= STALE_MS) return 'stale';
  return null;
}

/**
 * A next action of "merge" only survives when the pull request is actually
 * mergeable, its checks passed and it has been approved; otherwise it is
 * downgraded to "none" so the UI never offers to merge something that isn't
 * ready.
 */
export function downgradeNextAction(nextAction: TriageNextAction, pr: PullRequest): TriageNextAction {
  if (nextAction !== 'merge') return nextAction;
  const ready = pr.mergeable === 'MERGEABLE' && pr.checks.state === 'success' && pr.reviewDecision === 'APPROVED';
  return ready ? 'merge' : 'none';
}

export interface RawTriageItem {
  number?: unknown;
  summary?: unknown;
  state?: unknown;
  reason?: unknown;
  nextAction?: unknown;
}

/**
 * Builds one PrTriage entry from a raw model item, applying the deterministic
 * override and the merge downgrade, and enforcing the size caps. Returns null
 * when the item is malformed or does not name one of the pull requests in
 * `prByNumber` (a number the model was not asked about is never trusted).
 */
export function buildTriageEntry(raw: RawTriageItem, prByNumber: Map<number, PullRequest>, login: string | null, now: number, model: string, generatedAt: string): PrTriage | null {
  const number = typeof raw.number === 'number' && Number.isInteger(raw.number) ? raw.number : null;
  if (number === null) return null;
  const pr = prByNumber.get(number);
  if (!pr) return null;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, MAX_SUMMARY_CHARS) : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_REASON_CHARS) : '';
  if (!summary) return null;
  const modelState = TRIAGE_STATES.includes(raw.state as TriageState) ? (raw.state as TriageState) : null;
  if (!modelState) return null;
  const nextAction = TRIAGE_NEXT_ACTIONS.includes(raw.nextAction as TriageNextAction) ? (raw.nextAction as TriageNextAction) : 'none';
  const state = classifyTriageState(pr, login, now) ?? modelState;
  return {
    number,
    updatedAt: pr.updatedAt,
    headSha: pr.headSha,
    summary,
    state,
    reason,
    nextAction: downgradeNextAction(nextAction, pr),
    model,
    generatedAt,
  };
}

export interface TriageBatchResult {
  entries: PrTriage[];
  /** Numbers that were requested but missing or malformed in the batch response. */
  missingNumbers: number[];
}

/** Validates a whole batch response against the pull requests it was asked about. */
export function validateTriageBatch(raw: unknown, prs: PullRequest[], login: string | null, now: number, model: string, generatedAt: string): TriageBatchResult {
  const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items as RawTriageItem[]) : [];
  const entries: PrTriage[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = buildTriageEntry(item, prByNumber, login, now, model, generatedAt);
    if (!entry) continue;
    entries.push(entry);
    seen.add(entry.number);
  }
  const missingNumbers = prs.map((pr) => pr.number).filter((n) => !seen.has(n));
  return { entries, missingNumbers };
}

/** Splits `items` into consecutive chunks of at most `size`, preserving order. */
export function splitBatches<T>(items: T[], size: number = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Removes cache entries for pull requests no longer in `openNumbers` (closed
 * or merged since the entry was cached) and entries older than
 * CACHE_MAX_AGE_DAYS, per the spec's cache freshness/eviction requirement.
 */
export function evictTriageCache(cache: Record<number, PrTriage>, openNumbers: ReadonlySet<number>, now: number): Record<number, PrTriage> {
  const next: Record<number, PrTriage> = {};
  for (const [key, entry] of Object.entries(cache)) {
    const number = Number(key);
    if (!openNumbers.has(number)) continue;
    const generated = Date.parse(entry.generatedAt);
    if (!Number.isNaN(generated) && now - generated > CACHE_MAX_AGE_MS) continue;
    next[number] = entry;
  }
  return next;
}

/** True when a cached line still matches the pull request's current `updatedAt` (see the cache freshness requirement). */
export function isTriageFresh(entry: PrTriage | undefined, pr: PullRequest): boolean {
  return !!entry && entry.updatedAt === pr.updatedAt;
}
