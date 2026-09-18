/**
 * Pure helpers for the auto-updater: semver comparison, the release-channel
 * filter, the update state machine's reducer, the disabled-build detector
 * and the install safety gate. No Electron or Node imports so this can be
 * unit tested and reasoned about in isolation (mirrors the pattern in
 * src/main/ai/review-core.ts).
 */
import type { OperationKind, UpdateChannel, UpdateState } from '@shared/types';

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

interface ParsedVersion {
  parts: number[];
  prerelease: string | null;
}

/** Strips a leading "v"/"V" (as in git tags like "v1.2.3") before parsing. */
function parseVersion(raw: string): ParsedVersion {
  const cleaned = raw.trim().replace(/^v/i, '');
  const [core, ...rest] = cleaned.split('-');
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { parts, prerelease: rest.length ? rest.join('-') : null };
}

/**
 * Compares two version strings (with an optional leading "v" and an
 * optional "-prerelease" suffix), returning -1/0/1 like Array.prototype.sort
 * comparators. Numeric parts compare numerically (so "1.9.0" < "1.10.0");
 * a version with a prerelease suffix sorts before its release (per semver
 * precedence rules), and otherwise prerelease suffixes compare as strings.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const na = pa.parts[i] ?? 0;
    const nb = pb.parts[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1; // a is a release, b is a prerelease of the same core version: a is newer
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/** True when `candidate` is strictly newer than `current`. Never offers a downgrade or the same version. */
export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// Release channel filter
// ---------------------------------------------------------------------------

export interface ReleaseInfo {
  /** Normalized version (no leading "v"), e.g. "1.2.3". */
  version: string;
  releaseDate: string | null;
  notes: string | null;
  /** Web URL of the release, for the manual download link. */
  url: string;
  prerelease: boolean;
  draft: boolean;
}

/** True when a release is eligible to be offered on the given channel: never a draft, and a prerelease only on the beta channel. Does not check version recency; combine with isNewerVersion. */
export function isEligibleForChannel(release: Pick<ReleaseInfo, 'prerelease' | 'draft'>, channel: UpdateChannel): boolean {
  if (release.draft) return false;
  if (release.prerelease && channel !== 'beta') return false;
  return true;
}

// ---------------------------------------------------------------------------
// State machine reducer
// ---------------------------------------------------------------------------

export type UpdateEvent =
  | { type: 'disabled'; reason: string; manualUrl: string | null }
  | { type: 'check-start' }
  | { type: 'check-result'; release: ReleaseInfo | null; currentVersion: string; channel: UpdateChannel }
  | { type: 'check-error'; message: string; manualUrl: string | null }
  | { type: 'dismiss'; version: string };

/**
 * Advances the update state machine. Pure: given the same (state, event) it
 * always returns the same next state, so it is fully unit-testable without
 * a real provider, timers or Electron. The fallback provider only ever
 * drives 'check-start'/'check-result'/'check-error'/'dismiss'; 'disabled' is
 * applied once at startup by the caller.
 */
export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case 'disabled':
      return { status: 'disabled', reason: event.reason, manualUrl: event.manualUrl };
    case 'check-start':
      return state.status === 'disabled' ? state : { status: 'checking' };
    case 'check-error':
      return state.status === 'disabled' ? state : { status: 'error', message: event.message, manualUrl: event.manualUrl };
    case 'check-result': {
      if (state.status === 'disabled') return state;
      const release = event.release;
      if (!release || !isEligibleForChannel(release, event.channel) || !isNewerVersion(event.currentVersion, release.version)) {
        return { status: 'up-to-date' };
      }
      return { status: 'available', version: release.version, releaseDate: release.releaseDate, notes: release.notes, url: release.url, prerelease: release.prerelease, dismissed: false };
    }
    case 'dismiss':
      if (state.status === 'available' && state.version === event.version) return { ...state, dismissed: true };
      return state;
  }
}

// ---------------------------------------------------------------------------
// Disabled-build detection
// ---------------------------------------------------------------------------

export interface DisabledEnv {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** `process.env.PORTABLE_EXECUTABLE_DIR`, set by electron-builder's portable Windows target. */
  portableExecutableDir: string | undefined;
  /** `process.env.APPIMAGE`, set when running from an AppImage. */
  appImagePath: string | undefined;
  /** Whether the AppImage's own file is writable; irrelevant when `appImagePath` is unset. */
  appImageWritable: boolean;
}

/**
 * Returns a human-readable reason the updater is disabled for this build/run, or null when
 * checking should proceed. Every case here also has nowhere to install even
 * if we could check, so update checks are skipped entirely rather than
 * offering an update the user could never apply automatically.
 */
export function detectDisabledReason(env: DisabledEnv): string | null {
  if (!env.isPackaged) return 'Updates unavailable in this build (development / unpackaged).';
  if (env.portableExecutableDir) return 'Updates are unavailable in portable Windows builds. Download new versions manually.';
  if (env.appImagePath && !env.appImageWritable) return 'Updates are unavailable when running from a read-only location. Download new versions manually.';
  if (env.platform === 'darwin') return 'Updates are unavailable on this unsigned, non-notarised build. Download new versions manually.';
  return null;
}

// ---------------------------------------------------------------------------
// Install safety gate
// ---------------------------------------------------------------------------

export interface InstallGateContext {
  /** The current repository's in-progress operation kind, or 'none' when no repository is open or nothing is in progress. */
  operationKind: OperationKind;
  /** True while an AI conflict resolution or review run is active. */
  aiActive: boolean;
}

export type InstallGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Refuses to install while a merge/rebase/cherry-pick/revert is in progress
 * or an AI task is running, per the "Installation safety gates" requirement.
 * Bisect is left alone deliberately (matches Banners.tsx, which does not
 * treat an in-progress bisect as blocking other operations either).
 */
export function canInstall(ctx: InstallGateContext): InstallGateResult {
  if (ctx.operationKind !== 'none' && ctx.operationKind !== 'bisect') {
    return { ok: false, reason: `Cannot install while a ${ctx.operationKind} is in progress. Finish or abort it first.` };
  }
  if (ctx.aiActive) return { ok: false, reason: 'Cannot install while an AI task is running. Wait for it to finish or cancel it first.' };
  return { ok: true };
}
