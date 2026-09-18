# Spec Delta

## Purpose

Gives users one in-app inbox for GitHub activity that needs their attention, such as review requests, failing checks and mentions, with badges and desktop alerts, so they do not have to keep the GitHub notifications page open.

## ADDED Requirements

### Requirement: Inbox panel with unread badge
The system SHALL show a bell in the toolbar with the count of unread GitHub notifications and open an Inbox panel listing notifications grouped by repository, newest first, each with a reason chip, title, actor, relative time and unread indicator. The panel MUST offer filters for all, review requests, failures, mentions, and only repositories present in the app.

#### Scenario: New notification appears
- **WHEN** a new notification is created on GitHub for the signed-in user
- **THEN** within one poll interval the bell count increases and the item appears at the top of its repository group marked unread

#### Scenario: Filter to failures
- **WHEN** the user selects the *Failures* filter
- **THEN** only notifications whose reason is a failed check are listed and the badge count is unchanged

### Requirement: Polling respects server guidance and conserves quota
The system SHALL poll the notifications API no more often than the greater of the server-provided poll interval and the user's configured interval, MUST send conditional requests using the server's last-modified value, and MUST treat a not-modified response as no change. Polling MUST pause after 30 minutes without window focus and resume on focus.

#### Scenario: Not modified
- **WHEN** the server responds that nothing changed since the last poll
- **THEN** the list, badge and cache are left untouched and no items are re-fetched

#### Scenario: Server asks for a longer interval
- **WHEN** the server's poll-interval header is longer than the configured interval
- **THEN** the next poll is scheduled no sooner than the server's interval

#### Scenario: Idle pause
- **WHEN** the window has not been focused for more than 30 minutes
- **THEN** polling stops until the window regains focus, at which point a poll runs immediately

### Requirement: Open notifications in place
The system SHALL open a notification's subject inside the app when the repository is in the app's repository list and the subject is a pull request, otherwise in the browser. Opening an item MUST mark it read.

#### Scenario: Pull request in a known repository
- **WHEN** the user clicks a review-request notification for a pull request in a repository that is in the app
- **THEN** the Pull Request dialog opens on that pull request and the notification is marked read

#### Scenario: Subject in an unknown repository
- **WHEN** the user clicks a notification for a repository not in the app
- **THEN** the notification's web page opens in the browser and the notification is marked read

### Requirement: Read, unsubscribe and bulk actions
The system SHALL let the user mark a notification read, unsubscribe from its thread, open it on GitHub, mark all notifications read, and refresh. Mark all read MUST ask for confirmation once, with an option to remember the choice.

#### Scenario: Mark all read
- **WHEN** the user clicks *Mark all read* and confirms
- **THEN** GitHub records all notifications as read, every item loses its unread indicator and the badge shows zero

#### Scenario: Unsubscribe
- **WHEN** the user unsubscribes from a thread
- **THEN** GitHub removes the subscription and the item is removed from the list

### Requirement: Desktop notifications for enabled categories
The system SHALL send a desktop notification for each new inbox item whose category is enabled in settings, only while the window is unfocused. Clicking the desktop notification MUST focus the app and select the item. The first poll after a fresh install or a cache clear (i.e. one with no prior conditional-request cursor) MUST populate the panel and badge with the account's existing unread notifications but MUST NOT treat any of them as newly arrived for the purpose of desktop notifications.

#### Scenario: Review request while unfocused
- **WHEN** a review request arrives, review-request desktop alerts are enabled and the window is not focused
- **THEN** a desktop notification is shown and clicking it focuses the app with the item selected in the Inbox panel

#### Scenario: Category disabled
- **WHEN** a mention arrives and mention alerts are disabled
- **THEN** no desktop notification is shown, but the item still appears in the panel and badge

#### Scenario: First sync after install or cache clear
- **WHEN** the very first notifications poll runs after install, sign-in, or *Clear inbox cache*, and the account already has unread GitHub notifications
- **THEN** those notifications appear in the panel and badge but no desktop notification is shown for any of them

### Requirement: Badge on tray or dock
The system SHALL show the unread count as a taskbar overlay on Windows, a dock badge on macOS, and a launcher count on Linux where the desktop supports it, and clear it when the count is zero.

#### Scenario: Count clears
- **WHEN** the last unread notification is marked read
- **THEN** the platform badge is removed

### Requirement: Missing scope and degraded states
The system SHALL detect that the GitHub token lacks the `notifications` scope and offer a one-click scope refresh through the existing sign-in flow. When signed out, the bell MUST show a dot and open the sign-in card; when the GitHub CLI is unavailable the bell MUST be hidden; when rate-limited the panel MUST show the reset time and pause polling; when offline the last cached list MUST be shown with a stale timestamp.

#### Scenario: Scope missing
- **WHEN** the token lacks the `notifications` (or `repo`) scope
- **THEN** the panel explains the missing scope and offers *Grant access*, which runs the device-flow sign-in requesting the scope and then polls successfully

#### Scenario: Rate limited
- **WHEN** the notifications API returns a rate-limit error
- **THEN** the panel shows a banner with the reset time, the bell shows a paused marker, and no poll runs until that time

#### Scenario: Offline
- **WHEN** the network is unavailable
- **THEN** the panel shows the cached items with a *Last updated* timestamp and a stale banner

### Requirement: Cache privacy
The system SHALL cache notification items on disk only under the app's user-data directory and SHALL provide a *Clear inbox cache* action in Options → Advanced that deletes the cache.

#### Scenario: Clear cache
- **WHEN** the user clicks *Clear inbox cache*
- **THEN** the cache file is deleted and the panel reloads from GitHub on the next poll
