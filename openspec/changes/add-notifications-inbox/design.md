# Design

## Context

See proposal.md for motivation. `GhClient.run` executes `gh` but does not surface HTTP headers; the notifications endpoint relies on `X-Poll-Interval`, `Last-Modified` and 304 responses. The auto-fetch timer in the main process and the `window.focus` event already exist. `app.notify` sends desktop notifications; `app.setAppUserModelId` is already called on Windows. Settings `notifyPullRequestReviews` and `notifyPullRequestChecks` exist.

## Goals / Non-Goals

**Goals:**
- Zero extra quota usage when nothing changed; strictly honour server guidance.
- Reuse existing PR dialog, sign-in card, notification and timer code.

**Non-Goals:**
- GitHub Enterprise Server hosts (first version is github.com only, with a note otherwise).
- Replying to comments from the inbox; Discussions and Releases beyond opening in the browser.

## Decisions

- **`gh api … --include` for headers.** Add an `apiWithHeaders` helper that parses the header block from `--include` output. Alternative: `gh api -i` with `--jq`; rejected because we need both headers and body from one call.
- **Conditional requests.** Store the server's `Last-Modified` verbatim and send `If-Modified-Since`; a 304 (gh exits non-zero with empty body) means no change. Using the header verbatim avoids clock-skew issues.
- **Poll cadence** = max(`X-Poll-Interval`, `notificationsPollIntervalMinutes` setting, default 2 min); paused after 30 min without `window.focus`; resumed and run immediately on focus.
- **Subject mapping.** PR numbers are derived from the last path segment of the subject API URL to avoid a second request; PR state/draft are fetched lazily with the existing `prView` only when opening in place. Local repository match compares host/owner/name case-insensitively; forks match only when the notification's repo equals the fork.
- **Scope detection** from `GitHubAccount.scopes` in `ToolsState`; refresh via `gh auth refresh -s notifications`, reusing the device-flow code path (`gh.auth.refreshScopes`).
- **Badges**: `win.setOverlayIcon` on Windows, `app.dock.setBadge` on macOS, `app.setBadgeCount` on Linux (Unity/KDE where supported).
- **Cache** at `userData/inbox.json` with items and the last-modified value; cleared via a new advanced action.

Commands:

| Purpose | Command |
| --- | --- |
| Poll | `gh api notifications --paginate --include -H "If-Modified-Since: <last>"` |
| Mark read | `gh api -X PATCH notifications/threads/<id>` |
| Mark all read | `gh api -X PUT notifications -f last_read_at=<iso>` |
| Unsubscribe | `gh api -X DELETE notifications/threads/<id>/subscription` |
| Scope refresh | `gh auth refresh -s notifications` (device flow) |

Types and IPC:

```ts
type NotificationReason = 'review_requested' | 'ci_activity' | 'mention' | 'assign' | 'comment' | 'author' | 'state_change' | 'subscribed' | 'team_mention' | 'security_alert' | 'other'
interface InboxItem { id; threadId; repo: GitHubRepoRef; localRepoId: string | null; subject: { type: 'PullRequest' | 'Issue' | 'Release' | 'Discussion' | 'CheckSuite' | 'Other'; title; url: string | null; number: number | null }; reason; unread; updatedAt; lastReadAt: string | null }
interface InboxState { items: InboxItem[]; unreadCount; lastPolledAt: string | null; paused: 'rate-limit' | 'scope' | 'offline' | null; pausedUntil: string | null }

'gh.inbox.get': () => Promise<InboxState>
'gh.inbox.refresh': () => Promise<InboxState>
'gh.inbox.markRead': (threadIds: string[]) => Promise<void>
'gh.inbox.markAllRead': () => Promise<void>
'gh.inbox.unsubscribe': (threadId: string) => Promise<void>
'gh.auth.refreshScopes': (scopes: string[]) => Promise<{ ok; error }>
event 'gh.inbox.changed': InboxState
```

Settings: `notificationsEnabled` (default true when signed in), `notificationsPollIntervalMinutes` (default 2), `notifyMentions`, `notifyReviewRequests`; keep `notifyPullRequestReviews` and `notifyPullRequestChecks` as per-category desktop toggles.

UI: toolbar bell with badge; right-hand slide-over panel in the Toasts container shell; Window/View menu *Inbox*; shortcut `Ctrl+Shift+U` (`Ctrl+Shift+N` is taken by new branch).

## Risks / Trade-offs

- [Notifications quota is separate and easy to exhaust] → conditional requests, honour `X-Poll-Interval`, back off on 403 with `X-RateLimit-Reset`.
- [Private repository titles cached on disk] → cache only under user-data, document it in Options → Advanced, provide *Clear inbox cache*.
- [Mark all read is irreversible on github.com] → confirm once with a remember option.
- [Linux badge support varies] → best effort via `app.setBadgeCount`; no failure surfaced when unsupported.
- [Enterprise hosts] → out of scope; show a note when `gh auth status` lists a non-github.com host only.
