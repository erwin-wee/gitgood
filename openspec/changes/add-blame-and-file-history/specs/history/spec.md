# Spec Delta

## MODIFIED Requirements

### Requirement: Commit list is paged and searchable
The History tab SHALL show the commits reachable from the current branch, newest first, loading further pages on demand. A search box SHALL filter the list by commit message, author name or email, or a full or abbreviated SHA of at least 7 hexadecimal characters, matching case-insensitively. When a file history is active, the header SHALL show the file path with a control to clear it, the commit list SHALL contain only commits that touched that file, following renames, and the search box SHALL combine with the path filter.

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
- **WHEN** a file history is active for a path
- **THEN** only commits touching that path, including under its earlier names, are listed and the header shows the path with a clear control

#### Scenario: Clear file history
- **WHEN** the user clears the path chip
- **THEN** the full branch history returns and the search text is preserved

### Requirement: Commit details with per-file stats
Selecting a commit SHALL show its metadata (summary, description, author, date, SHA) and the list of changed files with additions and deletions, and selecting a file SHALL show that file's diff for the commit. When a file history is active, the tracked file's diff SHALL be shown first for the selected commit.

#### Scenario: Select a commit
- **WHEN** the user selects one commit
- **THEN** its files are listed with per-file change counts and the first file's diff is shown

#### Scenario: Binary file in commit
- **WHEN** a changed file is binary
- **THEN** its change counts are omitted and the diff pane shows the binary summary

#### Scenario: Select a commit in file history
- **WHEN** a file history is active and the user selects a commit
- **THEN** the diff shown first is that file's diff in the commit, under the name it had at that commit

## ADDED Requirements

### Requirement: File history entry points and file-at-commit actions
The user SHALL be able to open a file's history from the Changes tab, the History file list or the diff pane header menu. From a commit in file history the user SHALL be able to view the file as it was at that commit in a read-only viewer titled with the path and abbreviated SHA, blame the file at that commit, and restore that version to the working tree. Restore SHALL require confirmation and, when the file has uncommitted changes, SHALL offer to stash them first.

#### Scenario: Open file history
- **WHEN** the user chooses "File history" on a file
- **THEN** the History tab switches to file history mode for that path

#### Scenario: View file at commit
- **WHEN** the user chooses "View file at this commit"
- **THEN** a read-only view of the file content at that commit opens with a header naming the path and abbreviated SHA

#### Scenario: Restore with uncommitted changes
- **WHEN** the user chooses "Restore this version" and the file has uncommitted changes
- **THEN** a confirmation offers to stash the current changes before the old content is written

#### Scenario: Restore clean file
- **WHEN** the user confirms "Restore this version" for a file with no uncommitted changes
- **THEN** the working-tree file is overwritten with the historical content and appears as a change in the Changes tab
