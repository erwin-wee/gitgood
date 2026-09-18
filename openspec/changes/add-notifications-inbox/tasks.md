# Tasks

## 1. Shared contract and settings

- [x] 1.1 Add inbox types, `gh.inbox.*` and `gh.auth.refreshScopes` methods and the `gh.inbox.changed` event to `src/shared/types.ts` and `src/shared/ipc.ts`; verify `npm run typecheck` with stub handlers
- [x] 1.2 Add `notificationsEnabled`, `notificationsPollIntervalMinutes`, `notifyMentions`, `notifyReviewRequests` settings with defaults and the settings merge in `src/main/store.ts`; verify defaults load in a unit test

## 2. Main process

- [x] 2.1 Add a header-aware `gh api --include` helper in `src/main/gh/gh.ts` and a parser for header block + body; verify with unit tests including a 304 response
- [x] 2.2 Implement raw notification → `InboxItem` mapping (reason mapping, subject number extraction, local repository matching); verify with unit tests on canned JSON
- [x] 2.3 Implement the poller: cadence = max(server interval, setting), conditional requests, idle pause on lost focus and resume on focus, rate-limit and offline pause states, disk cache under user-data; verify scheduler unit tests and a stubbed-`gh` test for 200/304/403
- [x] 2.4 Implement mark read, mark all read, unsubscribe and scope refresh wrappers; verify argument shapes with a stubbed `gh`
- [x] 2.5 Implement platform badges (Windows overlay, macOS dock, Linux badge count) and desktop notifications for enabled categories while unfocused with click-to-focus; verify by driving the poller with a stub and observing notifications in a smoke run
- [x] 2.6 Register IPC handlers and the *Clear inbox cache* action; verify the cache file is removed

## 3. Renderer

- [x] 3.1 Add the toolbar bell with unread badge and paused marker, and the Window/View menu item and shortcut; verify the badge reflects `unreadCount` from stubbed state
- [x] 3.2 Build the Inbox slide-over panel: grouped list, reason chips, filters, header actions, stale/paused/signed-out/scope-missing states; verify each state renders with stubbed data
- [x] 3.3 Implement open-in-place for PRs of known repositories and browser fallback, marking items read; verify with a smoke script that the PR dialog opens for a known repo
- [x] 3.4 Implement mark all read confirmation with remember option, unsubscribe and refresh; verify `unreadCount === 0` after the mark-all-read action in a smoke dump
- [x] 3.5 Add the settings UI for inbox toggles, interval and per-category desktop alerts, plus *Clear inbox cache* in Options → Advanced; verify settings round-trip

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.2 Smoke pass with a stub producing three items: screenshot the bell badge and open panel; verify the screenshot shows grouped items and chips
- [x] 4.3 Update README Features and the shortcuts list; verify the text
