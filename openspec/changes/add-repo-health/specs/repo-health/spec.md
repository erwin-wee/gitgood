# Spec Delta

## Purpose

Surfaces what makes a repository slow or risky, such as large blobs in history, stale branches and unpushed work, and offers explicitly confirmed clean-up actions with an undo path where git allows one.

## ADDED Requirements

### Requirement: Health view with independent cards
A Repository health view, reachable from the Repository menu, a keyboard shortcut and a card on the Welcome screen, SHALL show four cards (Large files, Stale branches, Unpushed work, Housekeeping) that load, fail and retry independently, each showing progress while loading and supporting cancellation. The view SHALL show a single empty state for a repository with no commits.

#### Scenario: One card fails
- **WHEN** the large-files scan fails
- **THEN** that card shows the error with a Retry control while the other three cards show their results

#### Scenario: Cancel a slow scan
- **WHEN** the user cancels the large-files scan while it is running
- **THEN** the card returns to its idle state and no partial results are shown as complete

#### Scenario: Unborn repository
- **WHEN** the repository has no commits
- **THEN** the view shows one empty state instead of four cards

### Requirement: Large files card
The Large files card SHALL list the 25 largest blobs across the whole history with path, size, the commit that first added it, whether it is still present at HEAD and whether it would have been an LFS pointer. Each row SHALL offer Copy path, Add pattern to .gitignore and, when LFS is installed, Track with LFS. Paths containing spaces MUST be shown intact.

#### Scenario: Deleted large blob
- **WHEN** a 10 MB file was committed and later deleted
- **THEN** it appears in the card with its size, first commit and "not at HEAD"

#### Scenario: Path with spaces
- **WHEN** a large blob's path contains spaces
- **THEN** the full path is displayed and copied correctly

#### Scenario: LFS not installed
- **WHEN** git-lfs is not available
- **THEN** the Track with LFS action is hidden

### Requirement: Stale branches card
The Stale branches card SHALL classify local branches as merged into the default branch, inactive for more than the configured number of days, or having a gone upstream, and SHALL list remote-tracking branches whose remote branch no longer exists. The current branch, the default branch and branches known to be protected MUST NOT be selectable for deletion.

#### Scenario: Classification
- **WHEN** the repository has a merged branch, a branch with no commits in 120 days, and a branch whose upstream was deleted
- **THEN** each is listed with the matching reason

#### Scenario: Protected rows
- **WHEN** the current or default branch would otherwise qualify as stale
- **THEN** it is shown without a selection checkbox

### Requirement: Bulk branch deletion with undo
The user SHALL be able to select stale branches and delete them after a confirmation that lists each branch with its reason and tip commit, with an option, off by default, to also delete the remote branch. Failures SHALL be reported per branch without stopping the others. A toast after local deletion SHALL offer Undo, which recreates the deleted local branches at their recorded tips.

#### Scenario: Delete selected
- **WHEN** the user selects three branches and confirms without the remote option
- **THEN** the three local branches are deleted, remote branches are untouched and the toast offers Undo

#### Scenario: Partial failure
- **WHEN** one of the selected branches cannot be deleted
- **THEN** the others are deleted and the failure is reported for that branch by name

#### Scenario: Undo
- **WHEN** the user clicks Undo within the toast's lifetime
- **THEN** the deleted local branches exist again at the same commits

### Requirement: Unpushed work across repositories
The Unpushed work card and the Welcome screen card SHALL list, for every repository in the list that exists on disk, branches ahead of their upstream with the count, branches without an upstream, the number of stashes and the number of uncommitted changes. Clicking an entry SHALL open that repository on that branch. An opt-in indicator SHALL mark repository rows with unpushed work. Missing repositories SHALL be skipped.

#### Scenario: Aggregate view
- **WHEN** repository A has a branch 2 ahead and repository B has an unpublished branch and one stash
- **THEN** both repositories are listed with those items

#### Scenario: Navigate
- **WHEN** the user clicks the ahead branch of repository A
- **THEN** the app switches to repository A with that branch checked out or selected

#### Scenario: Missing repository
- **WHEN** a listed repository's directory no longer exists
- **THEN** it is skipped without an error

### Requirement: Housekeeping card
The Housekeeping card SHALL show the size of the git directory, loose object count, pack count and size, garbage count and the time of the last garbage collection, matching git's own object counts. It SHALL offer Run gc, Prune remotes and Expire reflog, each behind a two-step confirmation that explains what becomes unrecoverable, and all disabled while another operation is in progress.

#### Scenario: Numbers match git
- **WHEN** the card loads
- **THEN** loose object and pack counts equal those reported by git's count-objects

#### Scenario: Expire reflog
- **WHEN** the user confirms both steps of Expire reflog
- **THEN** the reflog is expired and the card reloads its numbers

#### Scenario: Blocked during an operation
- **WHEN** a fetch, merge or rebase is in progress
- **THEN** the housekeeping actions are disabled
