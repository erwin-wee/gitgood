# Spec Delta

## Purpose

Shows, for every line of a text file, which commit and author last changed it, and lets the user navigate from a line to its commit or re-blame the file before that commit.

## ADDED Requirements

### Requirement: Blame gutter for text files
The user SHALL be able to toggle a blame layer for any text file shown in the diff pane, from the Changes tab (working-tree content), the History tab (content at the selected commit), the diff pane header menu or a keyboard shortcut. The layer SHALL show one gutter block per run of consecutive lines from the same commit with the abbreviated SHA, author and relative date, coloured by commit age within the file. Lines not yet committed SHALL be labelled "Not committed yet". Blame SHALL be unavailable for binary, image, submodule and too-large files, and the menu item SHALL be disabled with a tooltip saying why.

#### Scenario: Blame the working tree file
- **WHEN** the user toggles Blame on a file in the Changes tab
- **THEN** every line shows a gutter block for its last commit, and uncommitted lines are labelled "Not committed yet"

#### Scenario: Blame at a commit
- **WHEN** the user toggles Blame on a file selected in History
- **THEN** the file content at that commit is blamed and no block references a later commit

#### Scenario: Binary file
- **WHEN** the selected file is binary or too large
- **THEN** the Blame item is disabled and its tooltip explains that blame is only available for text files

#### Scenario: Whitespace-only changes
- **WHEN** the ignore-whitespace blame setting is on
- **THEN** commits that only changed whitespace are skipped when attributing lines

### Requirement: Blame hover card and navigation
Hovering or focusing a gutter block SHALL show a card with the commit summary, author, full date and actions "Open commit", "Copy SHA" and "Blame at parent". "Open commit" SHALL select that commit in History. "Blame at parent" SHALL re-blame the file as it was before that commit, using the file's path at that time. Actions that require a commit SHALL be disabled for uncommitted lines. The card MUST be reachable by keyboard.

#### Scenario: Open commit
- **WHEN** the user clicks "Open commit" on a block
- **THEN** the History tab shows that commit selected with its files listed

#### Scenario: Blame at parent across a rename
- **WHEN** the user chooses "Blame at parent" on a block whose commit renamed the file
- **THEN** the blame is recomputed at the parent commit using the file's former path

#### Scenario: Uncommitted block
- **WHEN** the card is opened for a "Not committed yet" block
- **THEN** "Open commit" and "Blame at parent" are disabled

#### Scenario: Keyboard access
- **WHEN** a gutter block has focus and the user presses Enter
- **THEN** the hover card opens

### Requirement: Blame limits and shallow clones
Blame SHALL be limited to files of at most 20,000 lines, showing the too-large placeholder above that. In a shallow clone, the layer SHALL show "History truncated (shallow clone)" when attribution reaches the shallow boundary.

#### Scenario: Very large file
- **WHEN** the file has more than 20,000 lines
- **THEN** the too-large placeholder is shown and no blame is computed

#### Scenario: Shallow clone
- **WHEN** the repository is a shallow clone
- **THEN** the blame layer shows the truncation notice
