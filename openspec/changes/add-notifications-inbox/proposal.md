# Proposal

## Why

GitHub Desktop only notifies about checks and reviews for the current repository, so users keep github.com/notifications open in a browser tab. The app already has a signed-in GitHub CLI, an auto-fetch timer and desktop-notification settings to build on.

## What Changes

- Add an **Inbox** panel behind a toolbar bell that shows GitHub notifications: review requests, failed checks on the user's pull requests, mentions, assignments, comments and state changes, grouped by repository.
- Poll the GitHub notifications API through the GitHub CLI, honouring the server's poll interval and using conditional requests so quota is not consumed when nothing changed.
- Open notifications in place: pull requests of repositories known to the app open the Pull Request dialog; anything else opens the browser.
- Mark read, mark all read (confirmed once), unsubscribe, filter, and refresh.
- Desktop notifications for enabled categories while the window is unfocused; clicking focuses the app on the item.
- Tray/dock badge with the unread count.
- Detect a missing `notifications` OAuth scope and offer a one-click scope refresh through the existing device-flow sign-in.

## Capabilities

### New Capabilities
- `notifications-inbox`: polling, displaying and acting on GitHub notifications inside the app, including badges and desktop alerts.

### Modified Capabilities
- (none; existing desktop-notification settings are reused as per-category toggles without changing their meaning.)

## Impact

- `gh` commands: `gh api notifications --paginate --include -H "If-Modified-Since: …"`, `gh api -X PATCH notifications/threads/<id>`, `gh api -X PUT notifications -f last_read_at=…`, `gh api -X DELETE notifications/threads/<id>/subscription`, `gh auth refresh -s notifications`, plus existing PR view/checks wrappers for subject details.
- Code: `src/main/gh/gh.ts` (header-aware `gh api` helper, inbox wrappers), a new inbox poller in the main process reusing the auto-fetch timer pattern, `src/shared/types.ts` / `src/shared/ipc.ts` (inbox types, methods, event), `src/main/store.ts` (settings, cache file), renderer toolbar bell and slide-over panel, Window menu, tray/dock badge in `src/main/window.ts` or `index.ts`.
- Outward-facing actions (mark read, mark all read, unsubscribe) run only on explicit user action; *Mark all read* confirms once.
- Privacy: titles of private repositories are cached on disk under the user-data directory; a *Clear inbox cache* action is provided.
