import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../src/shared/types';
import { FIX_ACTIONS, getFixAction, riskMax } from '../src/main/ai/fixActions';
import { checkLockFileGuard, extractRemoteHost, isSafeCopyCommand, scrubAndTail, scrubSecrets, tailText, validateErrorExplanation, validateFixes } from '../src/main/ai/error-explain-core';

function status(overrides: Partial<RepositoryStatus> = {}): RepositoryStatus {
  return {
    branch: { name: 'main', sha: 'abc123', upstream: 'origin/main', ahead: 0, behind: 0, detached: false, unborn: false, upstreamGone: false },
    files: [],
    operation: { kind: 'none', headName: null, onto: null, ontoName: null, current: null, total: null, targetSha: null, targetName: null, message: null },
    hasConflicts: false,
    lastFetched: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

describe('scrubSecrets', () => {
  it('masks a GitHub personal access token', () => {
    expect(scrubSecrets('remote: Invalid token: ghp_1234567890abcdefghij1234567890ABCD')).toBe('remote: Invalid token: ghp_***');
  });

  it('masks a fine-grained GitHub PAT', () => {
    expect(scrubSecrets('using github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz')).toContain('github_pat_***');
  });

  it('masks gho_/ghu_/ghs_/ghr_ tokens', () => {
    expect(scrubSecrets('gho_abcdefghijklmnopqrstuvwxyz012345')).toBe('gho_***');
    expect(scrubSecrets('ghu_abcdefghijklmnopqrstuvwxyz012345')).toBe('ghu_***');
    expect(scrubSecrets('ghs_abcdefghijklmnopqrstuvwxyz012345')).toBe('ghs_***');
    expect(scrubSecrets('ghr_abcdefghijklmnopqrstuvwxyz012345')).toBe('ghr_***');
  });

  it('masks a Bearer token', () => {
    expect(scrubSecrets('Authorization: Bearer abcDEF123.token-value')).toBe('Authorization: Bearer ***');
  });

  it('masks URL userinfo credentials for any scheme', () => {
    expect(scrubSecrets("fatal: unable to access 'https://alice:hunter2@github.com/org/repo.git/'")).toBe("fatal: unable to access 'https://***:***@github.com/org/repo.git/'");
    expect(scrubSecrets('ssh://user:s3cr3t@example.com/repo.git')).toBe('ssh://***:***@example.com/repo.git');
  });

  it('masks an ANTHROPIC_API_KEY value', () => {
    expect(scrubSecrets('ANTHROPIC_API_KEY=sk-ant-abc123DEF456')).toBe('ANTHROPIC_API_KEY=***');
  });

  it('masks a bare sk-ant- key', () => {
    expect(scrubSecrets('key was sk-ant-api03-abcdefghij0123456789')).toBe('key was sk-ant-***');
  });

  it('leaves ordinary text untouched', () => {
    expect(scrubSecrets('fatal: Authentication failed for https://github.com/org/repo.git/')).toBe('fatal: Authentication failed for https://github.com/org/repo.git/');
  });
});

describe('tailText / scrubAndTail', () => {
  it('keeps text under the limit unchanged', () => {
    expect(tailText('short', 4000)).toBe('short');
  });

  it('keeps only the last N characters', () => {
    const text = 'a'.repeat(50) + 'END';
    expect(tailText(text, 10)).toBe('aaaaaaaEND');
  });

  it('scrubs before tailing so a token is never split and leaked at the boundary', () => {
    const prefix = '.'.repeat(3990);
    const text = `${prefix}ghp_1234567890abcdefghij1234567890ABCD`;
    const out = scrubAndTail(text, 4000);
    expect(out).not.toContain('1234567890abcdefghij');
    expect(out).toContain('ghp_***');
  });
});

// ---------------------------------------------------------------------------
// Remote host extraction
// ---------------------------------------------------------------------------

describe('extractRemoteHost', () => {
  it('extracts the host from an https URL', () => {
    expect(extractRemoteHost('https://github.com/org/repo.git')).toBe('github.com');
  });

  it('extracts the host from an https URL with embedded credentials', () => {
    expect(extractRemoteHost('https://user:pass@github.example.com/org/repo.git')).toBe('github.example.com');
  });

  it('extracts the host from the scp-like ssh form', () => {
    expect(extractRemoteHost('git@github.com:org/repo.git')).toBe('github.com');
  });

  it('returns null for a local path', () => {
    expect(extractRemoteHost('/home/user/bare-repos/lib.git')).toBeNull();
    expect(extractRemoteHost('../lib.git')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix action map: applicability
// ---------------------------------------------------------------------------

describe('fixActions applicability', () => {
  it('every action id is unique and every action is reachable by id', () => {
    const ids = FIX_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(getFixAction(id)?.id).toBe(id);
  });

  it('returns null for an unknown id', () => {
    expect(getFixAction('not-a-real-action')).toBeNull();
  });

  it('continue-rebase only applies during a rebase', () => {
    const continueRebase = getFixAction('continue-rebase')!;
    expect(continueRebase.appliesTo(status({ operation: { ...status().operation, kind: 'rebase' } }), true)).toBe(true);
    expect(continueRebase.appliesTo(status(), true)).toBe(false);
    expect(continueRebase.appliesTo(null, true)).toBe(false);
  });

  it('abort-merge only applies during a merge, not a rebase', () => {
    const abortMerge = getFixAction('abort-merge')!;
    expect(abortMerge.appliesTo(status({ operation: { ...status().operation, kind: 'merge' } }), true)).toBe(true);
    expect(abortMerge.appliesTo(status({ operation: { ...status().operation, kind: 'rebase' } }), true)).toBe(false);
  });

  it('push-set-upstream only applies when the branch has no upstream (or a gone one)', () => {
    const pushSetUpstream = getFixAction('push-set-upstream')!;
    expect(pushSetUpstream.appliesTo(status({ branch: { ...status().branch, upstream: null } }), true)).toBe(true);
    expect(pushSetUpstream.appliesTo(status({ branch: { ...status().branch, upstreamGone: true } }), true)).toBe(true);
    expect(pushSetUpstream.appliesTo(status(), true)).toBe(false); // has an upstream already
  });

  it('force-push-with-lease requires an existing upstream', () => {
    const forcePush = getFixAction('force-push-with-lease')!;
    expect(forcePush.appliesTo(status(), true)).toBe(true);
    expect(forcePush.appliesTo(status({ branch: { ...status().branch, upstream: null } }), true)).toBe(false);
  });

  it('stash-and-retry and discard-and-retry require uncommitted changes', () => {
    const stash = getFixAction('stash-and-retry')!;
    const discard = getFixAction('discard-and-retry')!;
    const dirty = status({ files: [{ path: 'a.txt', oldPath: null, status: 'modified', staged: false, unstaged: true, submodule: false, conflict: null, lfs: false }] });
    expect(stash.appliesTo(dirty, true)).toBe(true);
    expect(discard.appliesTo(dirty, true)).toBe(true);
    expect(stash.appliesTo(status(), true)).toBe(false);
    expect(discard.appliesTo(status(), true)).toBe(false);
  });

  it('open-sign-in applies even with no repository open', () => {
    expect(getFixAction('open-sign-in')!.appliesTo(null, false)).toBe(true);
  });

  it('every other action requires a repository', () => {
    for (const action of FIX_ACTIONS) {
      if (action.id === 'open-sign-in') continue;
      expect(action.appliesTo(status(), false)).toBe(false);
    }
  });
});

describe('riskMax', () => {
  it('returns the more destructive of two risks', () => {
    expect(riskMax('safe', 'touches-remote')).toBe('touches-remote');
    expect(riskMax('discards-work', 'changes-history')).toBe('discards-work');
    expect(riskMax('safe', 'safe')).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// Fix validation
// ---------------------------------------------------------------------------

describe('isSafeCopyCommand', () => {
  it('accepts a plain git command', () => {
    expect(isSafeCopyCommand('git fetch --prune')).toBe(true);
    expect(isSafeCopyCommand('gh pr checkout 42')).toBe(true);
  });

  it('rejects a chained command', () => {
    expect(isSafeCopyCommand('git fetch && git pull')).toBe(false);
  });

  it('rejects shell operators', () => {
    for (const cmd of ['git fetch; rm -rf /', 'git log | cat', 'git show > out.txt', 'git show < in.txt', 'git log `whoami`', 'git log $(whoami)', 'git status && echo $HOME']) {
      expect(isSafeCopyCommand(cmd)).toBe(false);
    }
  });

  it('rejects anything not starting with git or gh', () => {
    expect(isSafeCopyCommand('rm -rf .git')).toBe(false);
    expect(isSafeCopyCommand('npm install')).toBe(false);
  });

  it('rejects an empty or bare command', () => {
    expect(isSafeCopyCommand('')).toBe(false);
    expect(isSafeCopyCommand('git')).toBe(false);
  });
});

describe('validateFixes', () => {
  const noUpstream = status({ branch: { ...status().branch, upstream: null } });

  it('keeps a known, applicable action fix and raises risk to the map\'s classification', () => {
    const fixes = validateFixes([{ label: 'Publish', detail: 'Push and set upstream.', action: 'push-set-upstream', command: null, retryAfter: false, risk: 'safe' }], noUpstream, true, false);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ action: 'push-set-upstream', risk: 'touches-remote' });
  });

  it('drops a known action that does not apply to the current state', () => {
    const fixes = validateFixes([{ label: 'Continue rebase', detail: 'x', action: 'continue-rebase', command: null, retryAfter: false, risk: 'safe' }], status(), true, false);
    expect(fixes).toHaveLength(0);
  });

  it('downgrades an unknown action with a usable command to copy-only', () => {
    const fixes = validateFixes([{ label: 'Prune', detail: 'Prune remote-tracking refs.', action: 'some-made-up-action', command: 'git fetch --prune', retryAfter: false, risk: 'safe' }], status(), true, false);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ action: null, command: 'git fetch --prune' });
  });

  it('drops an unknown action with no usable command', () => {
    const fixes = validateFixes([{ label: 'x', detail: 'y', action: 'some-made-up-action', command: null, retryAfter: false, risk: 'safe' }], status(), true, false);
    expect(fixes).toHaveLength(0);
  });

  it('drops a copy-only fix whose command is chained or unsafe', () => {
    const fixes = validateFixes([{ label: 'x', detail: 'y', action: null, command: 'git fetch && git pull', retryAfter: false, risk: 'safe' }], status(), true, false);
    expect(fixes).toHaveLength(0);
  });

  it('never sets retryAfter on a copy-only fix, even if the model asked for it', () => {
    const fixes = validateFixes([{ label: 'x', detail: 'y', action: null, command: 'git fetch', retryAfter: true, risk: 'safe' }], status(), true, true);
    expect(fixes[0].retryAfter).toBe(false);
  });

  it('only keeps retryAfter true when the failed operation was retryable', () => {
    const raw = [{ label: 'Fetch', detail: 'x', action: 'fetch', command: null, retryAfter: true, risk: 'safe' }];
    expect(validateFixes(raw, status(), true, true)[0].retryAfter).toBe(true);
    expect(validateFixes(raw, status(), true, false)[0].retryAfter).toBe(false);
  });

  it('caps fixes at 3, preferring the least destructive valid ones when there are more than 3', () => {
    const raw = [
      { label: 'a', detail: 'a', action: null, command: 'git fetch', retryAfter: false, risk: 'touches-remote' },
      { label: 'b', detail: 'b', action: null, command: 'git status', retryAfter: false, risk: 'safe' },
      { label: 'c', detail: 'c', action: null, command: 'git log', retryAfter: false, risk: 'discards-work' },
      { label: 'd', detail: 'd', action: null, command: 'git diff', retryAfter: false, risk: 'safe' },
    ];
    const fixes = validateFixes(raw, status(), true, false);
    expect(fixes).toHaveLength(3);
    expect(fixes.map((f) => f.risk)).toEqual(['safe', 'safe', 'discards-work']);
    expect(fixes.map((f) => f.label)).toEqual(['b', 'd', 'c']); // the touches-remote one ('a') is dropped for the cap
  });

  it('caps label/detail length and drops entries missing a label or detail', () => {
    const long = 'x'.repeat(600);
    const fixes = validateFixes(
      [
        { label: long, detail: long, action: null, command: 'git status', retryAfter: false, risk: 'safe' },
        { label: '', detail: 'y', action: null, command: 'git status', retryAfter: false, risk: 'safe' },
      ],
      status(),
      true,
      false,
    );
    expect(fixes).toHaveLength(1);
    expect(fixes[0].label.length).toBe(500);
    expect(fixes[0].detail.length).toBe(500);
  });

  it('ignores malformed entries in the array', () => {
    expect(validateFixes([null, 'not an object', 42, { label: 'ok', detail: 'ok', action: null, command: 'git status', retryAfter: false, risk: 'safe' }], status(), true, false)).toHaveLength(1);
  });

  it('returns an empty array for non-array input', () => {
    expect(validateFixes(undefined, status(), true, false)).toEqual([]);
    expect(validateFixes({}, status(), true, false)).toEqual([]);
  });
});

describe('validateErrorExplanation', () => {
  it('accepts a well-formed response', () => {
    const raw = { whatHappened: 'The push was rejected.', likelyCause: 'No upstream is configured.', fixes: [{ label: 'Publish', detail: 'x', action: 'push-set-upstream', command: null, retryAfter: false, risk: 'safe' }] };
    const explanation = validateErrorExplanation(raw, 'claude-opus-5', status({ branch: { ...status().branch, upstream: null } }), true, false);
    expect(explanation).not.toBeNull();
    expect(explanation!.whatHappened).toContain('rejected');
    expect(explanation!.fixes).toHaveLength(1);
    expect(explanation!.model).toBe('claude-opus-5');
  });

  it('rejects a response with no whatHappened', () => {
    expect(validateErrorExplanation({ whatHappened: '   ', likelyCause: 'x', fixes: [] }, 'm', status(), true, false)).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateErrorExplanation(null, 'm', status(), true, false)).toBeNull();
    expect(validateErrorExplanation('nope', 'm', status(), true, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stale lock-file guard
// ---------------------------------------------------------------------------

describe('checkLockFileGuard', () => {
  it('refuses when no lock file exists', () => {
    expect(checkLockFileGuard({ gitProcessRunning: false, lockAgeMs: null })).toMatchObject({ safe: false });
  });

  it('refuses when a git process is running, even if the lock is old', () => {
    expect(checkLockFileGuard({ gitProcessRunning: true, lockAgeMs: 60_000 })).toMatchObject({ safe: false });
  });

  it('refuses a lock younger than 10 seconds', () => {
    expect(checkLockFileGuard({ gitProcessRunning: false, lockAgeMs: 9999 })).toMatchObject({ safe: false });
  });

  it('allows removal once the lock is at least 10 seconds old and no git process is running', () => {
    expect(checkLockFileGuard({ gitProcessRunning: false, lockAgeMs: 10_000 })).toEqual({ safe: true, reason: null });
    expect(checkLockFileGuard({ gitProcessRunning: false, lockAgeMs: 60_000 })).toEqual({ safe: true, reason: null });
  });
});
