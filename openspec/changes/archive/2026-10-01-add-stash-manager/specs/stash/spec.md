# Spec Delta

## MODIFIED Requirements

### Requirement: Stash list
A dedicated Stashes view, reachable from the Changes tab header (showing the stash count), the Repository menu and a keyboard shortcut, SHALL list every stash in the repository newest first with its message, branch when known ("Unknown branch" otherwise), relative date, an indicator when it was created by the app, and its file count. The list SHALL refresh when repository refs change, including stashes created or dropped outside the app.

#### Scenario: Stashes from the terminal
- **WHEN** a stash was created outside the app
- **THEN** it appears in the view with its message and file count, marked as not created by the app, and with "Unknown branch" when the branch cannot be derived

#### Scenario: Open the view
- **WHEN** the user clicks the Stashes button in the Changes tab header or presses the shortcut
- **THEN** the Stashes view opens with the newest stash listed first

#### Scenario: Empty state
- **WHEN** the repository has no stashes
- **THEN** the view shows "No stashes" and a hint that files can be stashed from the Changes tab context menu

### Requirement: Inspect a stash
Selecting a stash SHALL list the files it contains, including untracked files carried by the stash, and selecting a file SHALL show its diff against the stash's parent commit. File lists SHALL be capped at 2,000 entries with a "Show more" control.

#### Scenario: View stashed file
- **WHEN** the user selects a stash and one of its tracked files
- **THEN** the diff pane shows the stashed changes for that file

#### Scenario: View untracked stashed file
- **WHEN** the user selects a stash that carries untracked files and picks one of them
- **THEN** the file is listed and its full content is shown as an added file

#### Scenario: Selected stash disappears
- **WHEN** the selected stash is dropped from outside the app
- **THEN** the view returns to an empty selection without an error

### Requirement: Restore and discard a stash
The user SHALL be able to apply a stash while keeping it, pop it (apply and drop), or drop it. Drop SHALL ask for confirmation when the corresponding confirmation setting is on, showing the message, branch and file count and stating that the stash cannot be recovered from the app. An apply or pop that conflicts SHALL keep the stash and start the conflict flow. Every stash action SHALL address the stash by its SHA and MUST fail with "Stash no longer exists" rather than act on a different entry when that SHA is gone.

#### Scenario: Apply and keep
- **WHEN** the user chooses Apply
- **THEN** the changes are applied to the working tree and the stash remains listed

#### Scenario: Pop
- **WHEN** the user chooses Pop and the changes apply cleanly
- **THEN** the changes are applied and the stash is removed from the list

#### Scenario: Restore with conflicts
- **WHEN** popping or applying a stash conflicts with the working tree
- **THEN** the conflict banner appears and the stash is still listed

#### Scenario: Discard
- **WHEN** the user confirms the drop of a stash
- **THEN** the stash is removed from the list

#### Scenario: Drop after another drop
- **WHEN** the user drops stash A and then drops stash B, which was listed below A
- **THEN** exactly B is removed, even though its `stash@{N}` index changed after A was dropped

#### Scenario: Drop a vanished stash
- **WHEN** the user drops a stash whose SHA is no longer in the stash list
- **THEN** the app reports "Stash no longer exists" and refreshes the list without dropping anything

## ADDED Requirements

### Requirement: Create branch from stash
The user SHALL be able to create a new branch from a stash; the branch is created at the stash's parent commit, checked out with the stash applied, and the stash is removed. Failures because the branch exists or the working tree is dirty SHALL be reported with git's message.

#### Scenario: Successful branch from stash
- **WHEN** the user enters a new branch name and confirms
- **THEN** the branch is checked out with the stashed changes uncommitted in the working tree and the stash is gone from the list

#### Scenario: Branch already exists
- **WHEN** the entered branch name already exists
- **THEN** the error is shown and no stash is removed

### Requirement: Stash selected files
When one or more files are selected in the Changes tab, the user SHALL be able to stash only those files with an optional message and an option to include untracked files; the rest of the working tree MUST remain untouched.

#### Scenario: Stash a subset
- **WHEN** the user selects two of five changed files and confirms "Stash selected files"
- **THEN** a stash containing exactly those two files is created and the other three remain changed in the working tree

#### Scenario: Cancel
- **WHEN** the user cancels the stash dialog
- **THEN** no stash is created and the working tree is unchanged
