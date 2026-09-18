# Spec Delta

## MODIFIED Requirements

### Requirement: Commit list is paged and searchable
The History tab SHALL show the commits reachable from the current branch, newest first, loading further pages on demand. A search box SHALL filter the list by commit message, author name or email, or a full or abbreviated SHA of at least 7 hexadecimal characters, matching case-insensitively. The search box SHALL also accept prefixed filters that MAY be combined with free text: `content:<text>` (commits whose diff added or removed the text), `regex:<expr>` (commits whose diff matches the regular expression), `path:<pathspec>`, `author:<text>`, `after:<date>`, `before:<date>` and `all:` (search every branch, tag and remote). Values containing spaces SHALL be quoted, with escaped quotes supported. A filter popover SHALL offer the same filters as form controls and SHALL stay in sync with the text in both directions. While any filter is active the header SHALL show the number of matching commits and a Clear control, and when `all:` is on each row SHALL show the refs that contain it. Changing the query SHALL cancel the search in progress. An invalid regular expression SHALL be reported inline without running the search or leaving the list loading.

#### Scenario: Paging
- **WHEN** the user scrolls to the end of the loaded commits and more commits exist
- **THEN** the next page is appended without losing the current selection

#### Scenario: Search by message or author
- **WHEN** the user types text that is not a SHA and has no prefix into the search box
- **THEN** the list shows only commits whose message or author matches the text, and the empty state reads "No commits match your search." when nothing matches

#### Scenario: Search by SHA
- **WHEN** the user types 7 to 40 hexadecimal characters
- **THEN** the commit with that SHA is shown first if it exists, followed by commits matching the text by message or author

#### Scenario: Path filter
- **WHEN** a `path:` filter is active
- **THEN** only commits touching that pathspec are listed

#### Scenario: Content search
- **WHEN** the user types `content:needle` in a repository where one commit added `needle`, one changed a line containing it and one removed it
- **THEN** the list contains the adding and removing commits only

#### Scenario: Regex search
- **WHEN** the user types `regex:^import` 
- **THEN** the list contains exactly the commits whose diff has a line matching the expression, including commits that only changed such a line

#### Scenario: Combined filters
- **WHEN** the user types `author:erwin after:2026-01-01 path:src/** fix`
- **THEN** only commits by a matching author, after that date, touching the path and matching "fix" by message are listed

#### Scenario: All refs
- **WHEN** the query contains `all:`
- **THEN** commits from every branch, tag and remote are searched and each row shows the refs containing it

#### Scenario: Popover round trip
- **WHEN** the user fills the filter popover and applies it
- **THEN** the search box shows the equivalent text syntax, and editing that text updates the popover fields

#### Scenario: Query change cancels search
- **WHEN** the user changes the query while a search is running
- **THEN** the running git process is cancelled and only the new query's results are shown

#### Scenario: Invalid regex
- **WHEN** the user types `regex:(` with unbalanced parentheses
- **THEN** an inline error appears under the search box and the commit list is not put into a loading state

#### Scenario: Slow search
- **WHEN** a search has run for more than 5 seconds
- **THEN** a hint suggests narrowing with a `path:` filter and the search remains cancellable

### Requirement: Commit details with per-file stats
Selecting a commit SHALL show its metadata (summary, description, author, date, SHA) and the list of changed files with additions and deletions, and selecting a file SHALL show that file's diff for the commit. When a content or regex search is active, the file list SHALL contain only files whose diff matches the search, and the diff pane SHALL scroll to and highlight the first matching line.

#### Scenario: Select a commit
- **WHEN** the user selects one commit
- **THEN** its files are listed with per-file change counts and the first file's diff is shown

#### Scenario: Binary file in commit
- **WHEN** a changed file is binary
- **THEN** its change counts are omitted and the diff pane shows the binary summary

#### Scenario: Select a result of a content search
- **WHEN** a `content:` search is active and the user selects a matching commit
- **THEN** only files whose diff contains the text are listed and the first matching line is highlighted in the diff

## ADDED Requirements

### Requirement: Search history for selection
When text is selected in the diff pane, the user SHALL be able to search history for it from the context menu or a keyboard shortcut, which focuses the search box with a `content:` filter for the selection.

#### Scenario: Search for selected text
- **WHEN** the user selects `computeTotal` in the diff and chooses "Search history for selection"
- **THEN** the History tab opens with `content:computeTotal` in the search box and results loading
