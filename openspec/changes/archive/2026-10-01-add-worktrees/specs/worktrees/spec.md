# Spec Delta

## Purpose

Lets a user keep several branches of one repository checked out side by side as git worktrees, and manage them from the app without touching the terminal.

## ADDED Requirements

### Requirement: Worktree list
A Worktrees dialog, reachable from the Repository menu and a keyboard shortcut, SHALL list every worktree of the current repository including the main one, showing its path, its branch or detached commit, badges for main, locked (with the lock reason when present) and prunable entries, and whether it has uncommitted changes. The dialog SHALL have loading, empty ("This repository has no additional worktrees") and error-with-retry states.

#### Scenario: List with mixed entries
- **WHEN** the repository has a main worktree, a worktree on a branch, a detached worktree and a locked worktree
- **THEN** all four are listed with the correct branch or commit and the correct badges

#### Scenario: Prunable entry
- **WHEN** a worktree's directory has been deleted from disk
- **THEN** its row shows a prunable badge with git's reason

### Requirement: Add a worktree
The user SHALL be able to add a worktree for an existing local or remote branch, for a new branch created from a chosen start point, or detached at a commit, choosing a directory that defaults to a sibling of the repository named after the repository and branch. On success the worktree SHALL be added to the repository list and opened. If the branch is already checked out in another worktree, the error SHALL say so and offer to open that worktree.

#### Scenario: Existing branch
- **WHEN** the user picks an existing local branch and confirms
- **THEN** a worktree is created at the chosen directory on that branch and the app switches to it

#### Scenario: New branch
- **WHEN** the user chooses "new branch", enters a name and a start point, and confirms
- **THEN** the branch is created at the start point and checked out in the new worktree

#### Scenario: Detached
- **WHEN** the user chooses a commit to check out detached
- **THEN** the worktree is created with a detached HEAD at that commit

#### Scenario: Branch in use elsewhere
- **WHEN** the chosen branch is already checked out in another worktree
- **THEN** the dialog reports that and offers "Open that worktree"

### Requirement: Worktrees in the repository list
Worktrees SHALL appear in the repository list nested under their main repository, labelled with their branch name, each with its own ahead/behind indicator. Selecting one SHALL switch the app to that worktree with every view reflecting its working tree and branch. Removing the main repository from the list SHALL warn that its worktrees will be removed from the list too.

#### Scenario: Switch between worktrees
- **WHEN** the user selects a nested worktree in the repository list
- **THEN** the Changes, History and Branches views show that worktree's state

#### Scenario: Remove main repository
- **WHEN** the user removes a repository that has listed worktrees
- **THEN** the confirmation mentions the worktrees and they disappear from the list together with it

### Requirement: Open, lock and unlock
From a worktree row the user SHALL be able to open it in the app, show it in the file manager, open it in the configured editor or terminal, and lock or unlock it with an optional reason. A locked worktree MUST NOT be removable until unlocked.

#### Scenario: Open in editor
- **WHEN** the user chooses "Open in editor" on a worktree
- **THEN** the configured editor opens at that worktree's path

#### Scenario: Locked removal blocked
- **WHEN** the user tries to remove a locked worktree
- **THEN** the Remove action is unavailable and the row indicates it must be unlocked first

### Requirement: Remove and prune
Removing a worktree SHALL require confirmation stating that its directory will be deleted and not moved to the Recycle Bin. If the worktree has uncommitted changes, the confirmation SHALL show the number of changed files and require a second explicit confirmation before forcing the removal. Prune SHALL run only after a confirmation listing the entries that will be pruned.

#### Scenario: Remove clean worktree
- **WHEN** the user confirms removal of a worktree with no changes
- **THEN** the directory is deleted, the entry disappears from the dialog and the repository list

#### Scenario: Remove dirty worktree
- **WHEN** the worktree has uncommitted changes
- **THEN** the dialog shows the changed-file count and removal happens only after a second confirmation

#### Scenario: Prune
- **WHEN** the user confirms Prune with two prunable entries listed
- **THEN** those entries are removed and the remaining worktrees are unaffected

### Requirement: Branch checkout conflicts and cross-worktree refresh
Checking out a branch that is active in another worktree SHALL fail with a message naming that worktree and offer to open it. A commit or branch created in one worktree SHALL be reflected in the branch list of the other worktrees within the file watcher's polling interval.

#### Scenario: Checkout blocked
- **WHEN** the user checks out a branch that another worktree has checked out
- **THEN** the error names the other worktree and offers to open it

#### Scenario: Refresh across worktrees
- **WHEN** a branch is created in worktree A
- **THEN** worktree B's branch list shows it after the next watcher refresh
