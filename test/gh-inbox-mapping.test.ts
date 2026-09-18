import { describe, expect, it } from 'vitest';
import { findLocalRepoId, mapReason, mapSubjectType, shouldNotifyInboxItem, subjectNumberFromApiUrl, subjectWebUrl, toInboxItem, toInboxItems, type RawNotification } from '../src/main/gh/inbox';
import type { InboxItem } from '../src/shared/types';

function rawNotification(overrides: Partial<RawNotification> = {}): RawNotification {
  return {
    id: '1',
    unread: true,
    reason: 'review_requested',
    updated_at: '2026-01-02T00:00:00Z',
    last_read_at: null,
    subject: { title: 'Add feature', url: 'https://api.github.com/repos/octo/repo/pulls/12', type: 'PullRequest' },
    repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' },
    ...overrides,
  };
}

describe('mapReason', () => {
  it('passes through recognized reasons', () => {
    expect(mapReason('mention')).toBe('mention');
    expect(mapReason('ci_activity')).toBe('ci_activity');
    expect(mapReason('security_alert')).toBe('security_alert');
  });

  it('falls back to "other" for a reason GitHub adds later', () => {
    expect(mapReason('invitation')).toBe('other');
    expect(mapReason('manual')).toBe('other');
  });
});

describe('mapSubjectType', () => {
  it('passes through the known subject types', () => {
    for (const t of ['PullRequest', 'Issue', 'Release', 'Discussion', 'CheckSuite']) expect(mapSubjectType(t)).toBe(t);
  });

  it('maps anything else to Other', () => {
    expect(mapSubjectType('RepositoryInvitation')).toBe('Other');
    expect(mapSubjectType('WorkflowRun')).toBe('Other');
  });
});

describe('subjectNumberFromApiUrl', () => {
  it('extracts the trailing number from a REST API url', () => {
    expect(subjectNumberFromApiUrl('https://api.github.com/repos/octo/repo/pulls/12')).toBe(12);
    expect(subjectNumberFromApiUrl('https://api.github.com/repos/octo/repo/issues/7')).toBe(7);
  });

  it('returns null for a missing or non-numeric url', () => {
    expect(subjectNumberFromApiUrl(null)).toBeNull();
    expect(subjectNumberFromApiUrl(undefined)).toBeNull();
    expect(subjectNumberFromApiUrl('https://api.github.com/repos/octo/repo/releases')).toBeNull();
  });
});

describe('subjectWebUrl', () => {
  it('builds a pull request url', () => {
    expect(subjectWebUrl('PullRequest', 'https://github.com/octo/repo', 12)).toBe('https://github.com/octo/repo/pull/12');
  });

  it('builds an issue url', () => {
    expect(subjectWebUrl('Issue', 'https://github.com/octo/repo', 7)).toBe('https://github.com/octo/repo/issues/7');
  });

  it('builds a discussion url', () => {
    expect(subjectWebUrl('Discussion', 'https://github.com/octo/repo', 3)).toBe('https://github.com/octo/repo/discussions/3');
  });

  it('returns null when there is no number, or for subject types with no direct page', () => {
    expect(subjectWebUrl('PullRequest', 'https://github.com/octo/repo', null)).toBeNull();
    expect(subjectWebUrl('CheckSuite', 'https://github.com/octo/repo', 5)).toBeNull();
    expect(subjectWebUrl('Release', 'https://github.com/octo/repo', 5)).toBeNull();
  });
});

describe('findLocalRepoId', () => {
  const repos = [
    { id: 'a', github: { host: 'github.com', owner: 'Octo', name: 'Repo', url: 'https://github.com/Octo/Repo' } },
    { id: 'b', github: { host: 'github.com', owner: 'other', name: 'thing', url: 'https://github.com/other/thing' } },
    { id: 'c', github: null },
  ];

  it('matches case-insensitively on owner and name', () => {
    expect(findLocalRepoId(repos, 'octo', 'repo')).toBe('a');
    expect(findLocalRepoId(repos, 'OTHER', 'THING')).toBe('b');
  });

  it('returns null when nothing matches, including repositories with no GitHub remote', () => {
    expect(findLocalRepoId(repos, 'nope', 'nope')).toBeNull();
  });

  it('does not match a fork of the repository against its parent', () => {
    // A notification on the upstream "octo/repo" must not resolve to a locally-added fork "me/repo".
    const withFork = [...repos, { id: 'd', github: { host: 'github.com', owner: 'me', name: 'repo', url: 'https://github.com/me/repo' } }];
    expect(findLocalRepoId(withFork, 'octo', 'repo')).toBe('a');
    expect(findLocalRepoId(withFork, 'me', 'repo')).toBe('d');
  });
});

describe('toInboxItem', () => {
  const repos = [{ id: 'local-1', github: { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' } }];

  it('maps a pull-request review-request notification end to end', () => {
    const item = toInboxItem(rawNotification(), repos);
    expect(item).toEqual({
      id: '1',
      threadId: '1',
      repo: { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' },
      localRepoId: 'local-1',
      subject: { type: 'PullRequest', title: 'Add feature', url: 'https://github.com/octo/repo/pull/12', number: 12 },
      reason: 'review_requested',
      unread: true,
      updatedAt: '2026-01-02T00:00:00Z',
      lastReadAt: null,
    });
  });

  it('leaves localRepoId null for a repository the app does not know', () => {
    const item = toInboxItem(rawNotification({ repository: { name: 'unknown', owner: { login: 'someone' }, html_url: 'https://github.com/someone/unknown' } }), repos);
    expect(item.localRepoId).toBeNull();
  });

  it('maps a read notification with a lastReadAt timestamp', () => {
    const item = toInboxItem(rawNotification({ unread: false, last_read_at: '2026-01-02T01:00:00Z' }), repos);
    expect(item.unread).toBe(false);
    expect(item.lastReadAt).toBe('2026-01-02T01:00:00Z');
  });
});

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: '1',
    threadId: '1',
    repo: { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' },
    localRepoId: null,
    subject: { type: 'PullRequest', title: 'Add feature', url: 'https://github.com/octo/repo/pull/1', number: 1 },
    reason: 'review_requested',
    unread: true,
    updatedAt: '2026-01-01T00:00:00Z',
    lastReadAt: null,
    ...overrides,
  };
}

const NOTIFY_ON = { notificationsEnabled: true, notifyReviewRequests: true, notifyMentions: true, notifyPullRequestChecks: true };

describe('shouldNotifyInboxItem', () => {
  it('is silenced entirely when notifications are disabled, regardless of category', () => {
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'other' }), { ...NOTIFY_ON, notificationsEnabled: false })).toBe(false);
  });

  it('gates review requests on notifyReviewRequests', () => {
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'review_requested' }), NOTIFY_ON)).toBe(true);
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'review_requested' }), { ...NOTIFY_ON, notifyReviewRequests: false })).toBe(false);
  });

  it('gates mentions and team mentions on notifyMentions', () => {
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'mention' }), { ...NOTIFY_ON, notifyMentions: false })).toBe(false);
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'team_mention' }), { ...NOTIFY_ON, notifyMentions: false })).toBe(false);
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'mention' }), NOTIFY_ON)).toBe(true);
  });

  it('gates check-suite activity on the existing notifyPullRequestChecks toggle', () => {
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'ci_activity' }), { ...NOTIFY_ON, notifyPullRequestChecks: false })).toBe(false);
    expect(shouldNotifyInboxItem(inboxItem({ reason: 'ci_activity' }), NOTIFY_ON)).toBe(true);
  });

  it('shows every other category whenever notifications are enabled at all (no dedicated toggle)', () => {
    for (const reason of ['assign', 'comment', 'author', 'state_change', 'subscribed', 'security_alert', 'other'] as const) {
      expect(shouldNotifyInboxItem(inboxItem({ reason }), { ...NOTIFY_ON, notifyReviewRequests: false, notifyMentions: false, notifyPullRequestChecks: false })).toBe(true);
    }
  });
});

describe('toInboxItems', () => {
  it('sorts newest-updated first', () => {
    const older = rawNotification({ id: '1', updated_at: '2026-01-01T00:00:00Z' });
    const newer = rawNotification({ id: '2', updated_at: '2026-01-03T00:00:00Z' });
    const items = toInboxItems([older, newer], []);
    expect(items.map((i) => i.id)).toEqual(['2', '1']);
  });
});
