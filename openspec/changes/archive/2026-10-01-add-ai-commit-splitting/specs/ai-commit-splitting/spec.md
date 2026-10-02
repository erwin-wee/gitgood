# Spec Delta

## Purpose

Turns one mixed working tree into a series of coherent commits by letting AI propose a hunk-level grouping that the user edits and approves before anything is committed.

## ADDED Requirements

### Requirement: Entry point and preconditions
The Changes tab commit form and the Repository menu SHALL offer **Split into commits with AI**. It SHALL be hidden when the AI provider is disabled, not actionable with a tooltip when fewer than two hunks are included, and not offered while a merge is in progress or when Amend is checked.

#### Scenario: Enough hunks
- **WHEN** the provider is enabled and at least two hunks are included
- **THEN** the action is actionable in the commit form overflow menu and the Repository menu

#### Scenario: Single hunk
- **WHEN** only one hunk is included
- **THEN** the action is visible but not actionable and the tooltip explains at least two hunks are needed

#### Scenario: Merge in progress
- **WHEN** a merge is in progress
- **THEN** the action is not offered

### Requirement: Pre-flight and proposal
Before calling the model the system SHALL show the number of files and hunks, the items that cannot be split (binary, image, submodule, conflicted, renamed, deleted and mode-changed files are whole-file only or excluded) and a size estimate, with Propose and Cancel. The proposal SHALL be cancellable and SHALL show progress. When the diff exceeds 150,000 bytes the pre-flight SHALL offer a file-only split that sends hunk headers and stats without bodies.

#### Scenario: Pre-flight shown
- **WHEN** the user activates the action
- **THEN** a card lists files, hunks, excluded items and the size estimate before any AI call

#### Scenario: Oversized diff
- **WHEN** the included diff exceeds 150,000 bytes
- **THEN** the pre-flight offers to split by file only

### Requirement: Plan integrity
Every included hunk MUST appear in exactly one proposed commit or in a Not included bucket. Unknown hunk identifiers and paths SHALL be dropped with a warning; a hunk assigned to several commits SHALL stay in the first; a whole-file assignment that overlaps hunk assignments SHALL be converted to its hunk identifiers. New (untracked), renamed, deleted and mode-changed files SHALL only be assigned whole. An empty proposed summary SHALL receive a placeholder and a warning, and Apply SHALL stay disabled until the user edits it. A proposal yielding zero or one commit SHALL be reported as already coherent and offer the normal commit flow.

#### Scenario: Duplicate assignment
- **WHEN** the model assigns the same hunk to two commits
- **THEN** the hunk stays in the first commit and a warning badge is shown

#### Scenario: Unassigned hunk
- **WHEN** the model leaves a hunk out of every commit
- **THEN** the hunk appears in the Not included bucket and is never committed silently

#### Scenario: Untracked file
- **WHEN** an untracked file is included
- **THEN** it can only be placed whole in one commit

#### Scenario: Already coherent
- **WHEN** the proposal contains one commit holding everything
- **THEN** the dialog says the change is already coherent and offers the normal commit flow

### Requirement: Editable plan
The plan dialog SHALL show ordered commit cards with summary, description, rationale and hunks, and a diff preview for the selected hunk. The user SHALL be able to drag hunks between commits and to Not included, reorder commits, merge two commits, edit messages and delete a card (its hunks move to Not included). Apply SHALL reflect the edited plan.

#### Scenario: Move a hunk
- **WHEN** the user drags a hunk from commit 2 to commit 1 and applies
- **THEN** the created commit 1 contains that hunk and commit 2 does not

#### Scenario: Delete a card
- **WHEN** the user deletes a commit card
- **THEN** its hunks appear in Not included and the remaining commits are renumbered

### Requirement: Sequential application
Apply SHALL create the commits in plan order using the same partial-patch path as a manual partial commit, showing progress and refreshing status after each commit. Before starting, Apply MUST compare the recorded content hashes of every included file with the current working tree and refuse with a Re-propose offer on any mismatch. If a patch fails to apply, the sequence MUST stop, already-created commits remain, nothing remains staged for the failed commit, and the dialog states which commit failed. Pre-commit hook failures SHALL stop the sequence and show the hook output.

#### Scenario: Successful apply
- **WHEN** the user applies a two-commit plan
- **THEN** History shows two new commits with the planned messages in order and the working tree contains only Not included hunks

#### Scenario: Working tree changed
- **WHEN** a file was edited after the plan was proposed and the user clicks Apply
- **THEN** no commit is created and the dialog offers Re-propose

#### Scenario: Patch fails mid-sequence
- **WHEN** the second of three patches fails to apply
- **THEN** the first commit exists, no content is staged, the remaining hunks are unchanged in the working tree and the dialog names the failed commit

### Requirement: Undo
After a successful apply, the completion toast SHALL offer **Undo all**, which restores the pre-split HEAD while keeping all changes in the working tree, and SHALL be offered only while the recorded start commit is still HEAD's ancestor and nothing has been pushed since.

#### Scenario: Undo
- **WHEN** the user clicks Undo all right after applying
- **THEN** HEAD is the recorded start commit and the working tree contains all the split changes unstaged

### Requirement: No automatic writes
The proposal MUST NOT stage or commit anything; only Apply creates commits, and nothing is ever pushed by this capability.

#### Scenario: Cancel the plan
- **WHEN** the user closes the plan dialog without applying
- **THEN** the index and working tree are unchanged
