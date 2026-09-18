# History Specification

## Purpose

The History tab lets a user browse, search and act on the commits of the current branch: view each commit's details and per-file diffs, and rewrite or reuse commits through revert, cherry-pick, branch and tag creation, checkout, squash, reorder, reword, drop, undo and amend.

## Requirements

### Requirement: Commit list is paged and searchable
The History tab SHALL show the commits reachable from the current branch, newest first, loading further pages on demand. A search box SHALL filter the list by commit message, author name or email, or a full or abbreviated SHA of at least 7 hexadecimal characters, matching case-insensitively.

#### Scenario: Paging
- **WHEN** the user scrolls to the end of the loaded commits and more commits exist
- **THEN** the next page is appended without losing the current selection

#### Scenario: Search by message or author
- **WHEN** the user types text that is not a SHA into the search box
- **THEN** the list shows only commits whose message or author matches the text, and the empty state reads "No commits match your search." when nothing matches

#### Scenario: Search by SHA
- **WHEN** the user types 7 to 40 hexadecimal characters
- **THEN** the commit with that SHA is shown first if it exists, followed by commits matching the text by message or author

#### Scenario: Path filter
- **WHEN** a path filter is active
- **THEN** only commits touching that path are listed

### Requirement: Commit details with per-file stats
Selecting a commit SHALL show its metadata (summary, description, author, date, SHA) and the list of changed files with additions and deletions, and selecting a file SHALL show that file's diff for the commit.

#### Scenario: Select a commit
- **WHEN** the user selects one commit
- **THEN** its files are listed with per-file change counts and the first file's diff is shown

#### Scenario: Binary file in commit
- **WHEN** a changed file is binary
- **THEN** its change counts are omitted and the diff pane shows the binary summary

### Requirement: Commit actions
From a commit the user SHALL be able to revert it, cherry-pick it to another branch, create a branch or tag from it, check it out (with confirmation), edit its message, drop it, and, for the newest commit, undo it or amend it. Actions that rewrite history SHALL run as an automated interactive rebase and SHALL report conflicts through the standard conflict flow.

#### Scenario: Revert
- **WHEN** the user chooses "Revert changes in commit"
- **THEN** a new commit undoing that commit is created, or the conflict flow starts if the revert conflicts

#### Scenario: Reword
- **WHEN** the user edits a commit message and confirms
- **THEN** the commit and its descendants are rewritten with the new message

#### Scenario: Drop
- **WHEN** the user confirms "Drop commit"
- **THEN** the commit is removed from the branch and later commits are rewritten

#### Scenario: Undo last commit
- **WHEN** the user clicks Undo on the newest commit
- **THEN** the commit is removed and its changes return to the working tree as uncommitted changes

### Requirement: Multi-select squash, cherry-pick and reorder
The user SHALL be able to select several commits and squash them into one, cherry-pick them together, or reorder them by drag and drop. Drag and drop SHALL be disabled while a search filter is active.

#### Scenario: Squash selection
- **WHEN** two or more commits are selected and the user confirms a squash
- **THEN** they are combined into a single commit with the chosen message

#### Scenario: Reorder by drag
- **WHEN** the user drags a commit to a new position with no search active
- **THEN** the branch is rewritten in the new order

#### Scenario: Reorder blocked during search
- **WHEN** a search filter is active
- **THEN** commit rows are not draggable
