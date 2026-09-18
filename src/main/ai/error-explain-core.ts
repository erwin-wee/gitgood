/**
 * Pure helpers for AI error explanation: secret scrubbing, remote host
 * extraction, fix validation against the fixed action map (fixActions.ts)
 * and live repository state, and the stale-lock-file guard decision. No
 * Electron or Node imports so these can be unit tested in isolation; the
 * orchestration (backend call, gathering repository context, the actual
 * process/filesystem checks behind the lock-file guard) lives in
 * error-explain.ts.
 */
import type { ErrorExplanation, ErrorFix, FixRisk, RepositoryStatus } from '@shared/types';
import { compareRisk, getFixAction, riskMax } from './fixActions';

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/** Streams sent to the model are cut to their last N characters, after scrubbing. */
export const DIAGNOSTIC_TAIL_LIMIT = 4000;

/** Order matters only in that every pattern is applied; they do not overlap. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***'],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, 'gho_***'],
  [/\bghu_[A-Za-z0-9]{20,}\b/g, 'ghu_***'],
  [/\bghs_[A-Za-z0-9]{20,}\b/g, 'ghs_***'],
  [/\bghr_[A-Za-z0-9]{20,}\b/g, 'ghr_***'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, 'sk-ant-***'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [/\bANTHROPIC_API_KEY=\S+/g, 'ANTHROPIC_API_KEY=***'],
  // URL userinfo, any scheme: https://user:pass@host, ssh://user:pass@host, ...
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/g, '$1***:***@'],
];

/** Masks known secret shapes (GitHub tokens, bearer tokens, URL userinfo, Anthropic API keys). Pure string transform; never throws. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Keeps only the last `max` characters, without splitting a multi-byte/surrogate pair at the boundary. */
export function tailText(text: string, max: number = DIAGNOSTIC_TAIL_LIMIT): string {
  if (text.length <= max) return text;
  let start = text.length - max;
  // Avoid starting mid-surrogate-pair.
  if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start += 1;
  return text.slice(start);
}

/** Scrubs first (so a token never survives half-truncated at the tail boundary), then caps length. */
export function scrubAndTail(text: string, max: number = DIAGNOSTIC_TAIL_LIMIT): string {
  return tailText(scrubSecrets(text), max);
}

// ---------------------------------------------------------------------------
// Remote host extraction (names and hosts only ever leave the process)
// ---------------------------------------------------------------------------

/** Extracts just the host from a remote URL (https/ssh/git URL form, or the scp-like `user@host:path` form); null for local paths or anything unrecognized. */
export function extractRemoteHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/.exec(trimmed);
  if (m) return m[1].toLowerCase();
  m = /^[^@\s/]+@([^:/\s]+):(?!\/\/)/.exec(trimmed);
  if (m) return m[1].toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// Fix validation
// ---------------------------------------------------------------------------

const MAX_FIXES = 3;
const MAX_FIX_TEXT_CHARS = 500;
const RISKS: readonly FixRisk[] = ['safe', 'changes-history', 'discards-work', 'touches-remote'];
/** Characters that make a copy-only command unsafe to display as a single literal `git`/`gh` invocation. */
const SHELL_OPERATOR_CHARS = /[;&|<>`$]/;

interface RawFix {
  label?: unknown;
  detail?: unknown;
  action?: unknown;
  command?: unknown;
  retryAfter?: unknown;
  risk?: unknown;
}

/** True for a single `git `/`gh `-prefixed command with no shell metacharacters, within the text cap. */
export function isSafeCopyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_FIX_TEXT_CHARS) return false;
  if (SHELL_OPERATOR_CHARS.test(trimmed)) return false;
  return /^(git|gh)\s+\S/.test(trimmed);
}

/**
 * Validates the model's raw `fixes` array against the fixed action map and
 * live repository state: unknown actions become copy-only (when a usable
 * command is given) or are dropped; known actions are dropped when
 * inapplicable to `status`; risk is the higher of the model's and the map's;
 * `retryAfter` is only ever kept true when the failed operation was
 * retryable. Keeps at most `MAX_FIXES`, ordered least to most destructive.
 */
export function validateFixes(raw: unknown, status: RepositoryStatus | null, hasRepo: boolean, retryable: boolean): ErrorFix[] {
  const list = Array.isArray(raw) ? (raw as RawFix[]) : [];
  const out: ErrorFix[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const label = typeof f.label === 'string' ? f.label.trim().slice(0, MAX_FIX_TEXT_CHARS) : '';
    const detail = typeof f.detail === 'string' ? f.detail.trim().slice(0, MAX_FIX_TEXT_CHARS) : '';
    if (!label || !detail) continue;
    const modelRisk: FixRisk = RISKS.includes(f.risk as FixRisk) ? (f.risk as FixRisk) : 'safe';
    const rawAction = typeof f.action === 'string' ? f.action : null;
    const rawCommand = typeof f.command === 'string' ? f.command.trim() : null;

    const known = rawAction ? getFixAction(rawAction) : null;
    if (rawAction !== null && known) {
      // A known action: dropped outright when it does not fit the current repository state (never
      // downgraded to copy-only — a command reconstructed from a known action would just repeat
      // what already got rejected).
      if (!known.appliesTo(status, hasRepo)) continue;
      out.push({ label, detail, action: known.id, command: null, retryAfter: f.retryAfter === true && retryable, risk: riskMax(modelRisk, known.risk) });
    } else if (rawCommand && isSafeCopyCommand(rawCommand)) {
      // Copy-only, either because the model omitted `action` or named one outside the fixed set.
      // Nothing actually runs, so there is nothing to retry after.
      out.push({ label, detail, action: null, command: rawCommand, retryAfter: false, risk: modelRisk });
    }
    // An unknown action with no usable command falls through and is dropped.
  }
  // Sort before capping so, when the model over-suggests, the fixes actually shown are the least
  // destructive valid ones rather than whichever happened to come first.
  return out.sort((a, b) => compareRisk(a.risk, b.risk)).slice(0, MAX_FIXES);
}

/** Validates the whole explanation payload; returns null when there is no usable `whatHappened`. */
export function validateErrorExplanation(raw: unknown, model: string, status: RepositoryStatus | null, hasRepo: boolean, retryable: boolean): ErrorExplanation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { whatHappened?: unknown; likelyCause?: unknown; fixes?: unknown };
  const whatHappened = typeof r.whatHappened === 'string' ? r.whatHappened.trim().slice(0, MAX_FIX_TEXT_CHARS * 2) : '';
  const likelyCause = typeof r.likelyCause === 'string' ? r.likelyCause.trim().slice(0, MAX_FIX_TEXT_CHARS * 2) : '';
  if (!whatHappened) return null;
  return { whatHappened, likelyCause, fixes: validateFixes(r.fixes, status, hasRepo, retryable), model };
}

// ---------------------------------------------------------------------------
// Stale lock-file guard
// ---------------------------------------------------------------------------

/** The lock file must be at least this old before removal is offered; a fresh lock likely belongs to a git process that is still starting. */
export const LOCK_FILE_MIN_AGE_MS = 10_000;

export interface LockFileGuardInput {
  /** True when a `git` process appears to be running on this machine. */
  gitProcessRunning: boolean;
  /** Milliseconds since the lock file's mtime, or null when the lock file does not exist. */
  lockAgeMs: number | null;
}

export interface LockFileGuardResult {
  safe: boolean;
  reason: string | null;
}

/** Pure decision for whether removing `.git/index.lock` is currently safe; the actual process/mtime checks live in error-explain.ts. */
export function checkLockFileGuard(input: LockFileGuardInput): LockFileGuardResult {
  if (input.lockAgeMs === null) return { safe: false, reason: 'No lock file was found; it may already have been removed.' };
  if (input.gitProcessRunning) return { safe: false, reason: 'A git process is currently running; removing the lock file now could corrupt the repository.' };
  if (input.lockAgeMs < LOCK_FILE_MIN_AGE_MS) return { safe: false, reason: 'The lock file was created less than 10 seconds ago and may belong to a git process that is still starting.' };
  return { safe: true, reason: null };
}
