import type { AppSettings, GitHubRepoRef, InboxItem, InboxSubjectType, NotificationReason } from '@shared/types';

/** Shape of one element of `gh api notifications`'s JSON array. */
export interface RawNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  last_read_at: string | null;
  subject: { title: string; url: string | null; type: string };
  repository: { name: string; owner: { login: string }; html_url: string };
}

const KNOWN_REASONS: readonly NotificationReason[] = ['review_requested', 'ci_activity', 'mention', 'assign', 'comment', 'author', 'state_change', 'subscribed', 'team_mention', 'security_alert', 'other'];

/** Maps GitHub's notification `reason` string to our closed set, falling back to 'other' for anything unrecognized (new reasons GitHub adds later). */
export function mapReason(raw: string): NotificationReason {
  return (KNOWN_REASONS as readonly string[]).includes(raw) ? (raw as NotificationReason) : 'other';
}

/** Maps GitHub's notification `subject.type` string to our closed set. */
export function mapSubjectType(raw: string): InboxSubjectType {
  if (raw === 'PullRequest' || raw === 'Issue' || raw === 'Release' || raw === 'Discussion' || raw === 'CheckSuite') return raw;
  return 'Other';
}

/** Extracts the issue/PR/discussion number from the subject's REST API URL (its last path segment), avoiding a second request just to learn it. */
export function subjectNumberFromApiUrl(apiUrl: string | null | undefined): number | null {
  if (!apiUrl) return null;
  const m = /\/(\d+)$/.exec(apiUrl);
  return m ? Number(m[1]) : null;
}

/** Builds the web URL to open in place (pull requests) or in the browser (issues/discussions); null when the subject type has no direct page (releases, check suites, anything else). */
export function subjectWebUrl(type: InboxSubjectType, repoHtmlUrl: string, number: number | null): string | null {
  if (number === null) return null;
  if (type === 'PullRequest') return `${repoHtmlUrl}/pull/${number}`;
  if (type === 'Issue') return `${repoHtmlUrl}/issues/${number}`;
  if (type === 'Discussion') return `${repoHtmlUrl}/discussions/${number}`;
  return null;
}

/**
 * Matches a notification's repository to one already known to the app.
 * github.com only (first version), case-insensitive on owner/name. A fork
 * only matches its own entry, never its parent: this compares the
 * notification's repository directly, so a notification whose repository is
 * the upstream (e.g. a PR opened from a fork against its parent) will not
 * match a locally-added fork of it.
 */
export function findLocalRepoId(repos: { id: string; github: GitHubRepoRef | null }[], owner: string, name: string): string | null {
  const o = owner.toLowerCase();
  const n = name.toLowerCase();
  return repos.find((r) => r.github && r.github.host === 'github.com' && r.github.owner.toLowerCase() === o && r.github.name.toLowerCase() === n)?.id ?? null;
}

/** Maps one raw notification JSON object into an `InboxItem`, resolving its local repository match. */
export function toInboxItem(raw: RawNotification, repos: { id: string; github: GitHubRepoRef | null }[]): InboxItem {
  const owner = raw.repository.owner.login;
  const name = raw.repository.name;
  const subjectType = mapSubjectType(raw.subject.type);
  const number = subjectNumberFromApiUrl(raw.subject.url);
  const repo: GitHubRepoRef = { host: 'github.com', owner, name, url: raw.repository.html_url };
  return {
    id: raw.id,
    threadId: raw.id,
    repo,
    localRepoId: findLocalRepoId(repos, owner, name),
    subject: { type: subjectType, title: raw.subject.title, url: subjectWebUrl(subjectType, raw.repository.html_url, number), number },
    reason: mapReason(raw.reason),
    unread: raw.unread,
    updatedAt: raw.updated_at,
    lastReadAt: raw.last_read_at,
  };
}

/** Maps and sorts a page of raw notifications, newest-updated first. */
export function toInboxItems(raw: RawNotification[], repos: { id: string; github: GitHubRepoRef | null }[]): InboxItem[] {
  return raw.map((r) => toInboxItem(r, repos)).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Whether a freshly-arrived item should raise a desktop notification: gated
 * per-category by the settings that have a dedicated toggle (review
 * requests, mentions/team-mentions reuse `notifyMentions`, check-suite
 * activity reuses the existing `notifyPullRequestChecks` toggle); every
 * other reason has no specific toggle and is shown whenever notifications
 * are enabled at all. Pure so the category gating can be unit tested without
 * touching Electron's Notification API (unavailable/unreliable headlessly).
 */
export function shouldNotifyInboxItem(item: InboxItem, settings: Pick<AppSettings, 'notificationsEnabled' | 'notifyReviewRequests' | 'notifyMentions' | 'notifyPullRequestChecks'>): boolean {
  if (!settings.notificationsEnabled) return false;
  if (item.reason === 'review_requested') return settings.notifyReviewRequests;
  if (item.reason === 'mention' || item.reason === 'team_mention') return settings.notifyMentions;
  if (item.reason === 'ci_activity') return settings.notifyPullRequestChecks;
  return true;
}
