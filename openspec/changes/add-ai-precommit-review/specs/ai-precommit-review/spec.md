# Spec Delta

## Purpose

Reviews the exact patch a user is about to commit with AI and surfaces anchored findings before the commit is made, so mistakes are caught at the cheapest moment.

## ADDED Requirements

### Requirement: Review action in the commit form
The Changes tab commit form SHALL offer a **Review changes** action when the AI provider is enabled and at least one text file is included in the commit. The action SHALL be hidden when the provider is disabled. When only binary, image or submodule entries are included, activating the action SHALL report that there is nothing to review.

#### Scenario: Provider enabled with text files
- **WHEN** the provider is enabled and the user includes at least one text file
- **THEN** the Review changes action is visible next to the AI commit message action

#### Scenario: Provider disabled
- **WHEN** the provider setting is `disabled`
- **THEN** no Review changes action is rendered

#### Scenario: Only binary files included
- **WHEN** every included file is binary or an image
- **THEN** activating the action shows a "Nothing to review" message and makes no AI call

### Requirement: Review exactly what will be committed
The review MUST be run against the patch that the commit would apply: whole files for fully included files, only the selected lines for partially selected files, and the full content of untracked files. When amending, the patch SHALL be taken against the previous commit; during a merge in progress the review SHALL cover the index. Findings MUST reference only lines present in that patch.

#### Scenario: Partial selection
- **WHEN** the user has selected some but not all added lines in a file and runs the review
- **THEN** every finding for that file refers to a selected line and none refers to an unselected addition

#### Scenario: Untracked file
- **WHEN** an untracked file is included
- **THEN** its findings use the file's own line numbers on the new side

#### Scenario: Amend mode
- **WHEN** Amend last commit is checked and HEAD has a parent
- **THEN** the reviewed patch is the difference against the parent of HEAD combined with the working changes

#### Scenario: Merge in progress
- **WHEN** a merge is in progress
- **THEN** the review covers the index contents rather than the working-tree diff

### Requirement: Findings presentation
Completed findings SHALL appear as a strip above the commit form with counts by severity and a Show toggle, and as gutter markers on the affected lines in the diff pane. Selecting a finding SHALL select its file and scroll the diff to its line. Each finding SHALL offer Dismiss, Copy suggestion and Open in editor. Findings the validation dropped SHALL be counted and shown, not displayed.

#### Scenario: Finding selected
- **WHEN** the user clicks a finding in the strip
- **THEN** the finding's file becomes the selected file and the diff pane scrolls to the finding's line with the finding card open

#### Scenario: No findings
- **WHEN** the review completes with zero findings
- **THEN** the strip reads "No issues found in N files"

### Requirement: Blockers warn but never block
When at least one finding has blocker severity, the Commit button SHALL change appearance and its tooltip SHALL state the blocker count. Committing MUST remain possible.

#### Scenario: Blocker present
- **WHEN** a blocker finding exists and is not dismissed
- **THEN** the Commit button is highlighted with a tooltip such as "1 blocker found, review before committing" and clicking it still commits

### Requirement: Apply a suggestion to the working tree
A finding with a whole-line suggestion and a line range SHALL offer **Apply to file**. Applying MUST write the suggestion into the working tree preserving the file's line endings, and MUST be refused when the file's content hash differs from the hash recorded when the review ran or when the file is partially selected. Nothing is written without the explicit Apply action.

#### Scenario: Apply succeeds
- **WHEN** the file is unchanged since the review and the user clicks Apply to file
- **THEN** the suggested lines replace the finding's range, the file keeps its CRLF or LF endings and the change list refreshes

#### Scenario: File changed since review
- **WHEN** the file was edited after the review and the user clicks Apply to file
- **THEN** the write is refused and the user is told to re-review first

#### Scenario: Partially selected file
- **WHEN** the finding is in a partially selected file
- **THEN** Apply to file is not offered

### Requirement: Staleness and re-review
The system SHALL record a content hash per reviewed file. When a reviewed file's content changes, its findings SHALL be shown as stale. When the set of included files changes by adding or removing a file, findings SHALL be cleared. **Re-review** SHALL send only files whose findings are stale.

#### Scenario: File edited after review
- **WHEN** the user edits a reviewed file in an external editor
- **THEN** that file's findings are greyed as stale and other files' findings stay unchanged

#### Scenario: Re-review
- **WHEN** the user clicks Re-review with two stale files out of five
- **THEN** only the two stale files are sent to the model and the other three keep their findings

### Requirement: Commit message consistency
The review SHALL receive the commit summary and description typed so far and SHALL report when the diff contradicts them. The note SHALL be shown next to the summary field.

#### Scenario: Summary contradicts diff
- **WHEN** the summary says "Remove logging" and the diff only adds code
- **THEN** an intent-mismatch note appears next to the summary field

### Requirement: Optional review before every commit
A setting **Review before every commit** (default off) SHALL, when on, run the review when the user clicks Commit and show the findings in a confirmation with **Commit anyway** and **Go back**. Go back MUST leave the working tree, index and form unchanged.

#### Scenario: Gate enabled with findings
- **WHEN** the setting is on and the user clicks Commit and the review returns findings
- **THEN** a dialog lists the findings with Commit anyway and Go back, and Commit anyway creates the commit

#### Scenario: Gate enabled without findings
- **WHEN** the setting is on and the review returns no findings
- **THEN** the commit proceeds without an extra confirmation

### Requirement: Progress, cancellation and limits
The review SHALL show per-file progress and be cancellable, keeping findings gathered so far. It SHALL apply the shared skip rules and maximum-files setting, offering file selection in a pre-flight when the selection exceeds the cap. A backend error SHALL keep partial findings and show the classified message.

#### Scenario: Cancel mid-run
- **WHEN** the user cancels after two of five files were reviewed
- **THEN** findings for the two files remain and the remaining files are marked as not reviewed

#### Scenario: Over the file cap
- **WHEN** more files are included than the maximum-files setting allows
- **THEN** a pre-flight card lists skipped files and lets the user choose which to review
