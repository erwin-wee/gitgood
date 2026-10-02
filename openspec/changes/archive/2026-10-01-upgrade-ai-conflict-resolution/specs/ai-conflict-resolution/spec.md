# Spec Delta

## MODIFIED Requirements

### Requirement: Each conflict block receives a structured resolution
For each conflict block GitGood SHALL send the block (ours, theirs and base when diff3 markers are present) with surrounding context, the in-progress operation (merge, rebase, cherry-pick or revert), branch names and recent commit subjects on both sides, and SHALL request a JSON answer containing, per block, the replacement text, a one-sentence rationale and a confidence of high, medium or low. When the user has manually resolved other files in the same operation and chose a guided run, the request SHALL also include up to three of those manual resolutions as worked examples, trimmed to their conflict blocks plus 20 lines of context and capped at 12,000 bytes in total. When the run is a retry after a failed post-resolution check, the request SHALL include the failing command and the last 4,000 characters of its output.

#### Scenario: diff3 markers
- **WHEN** the conflicted file uses diff3 or zdiff3 markers with a base section
- **THEN** the base text is included in the request for that block

#### Scenario: Complete answer
- **WHEN** the model answers with one resolution per block
- **THEN** every block is replaced by its resolution and the rationale and confidence are kept for display

#### Scenario: Guided run includes examples
- **WHEN** the user chooses Resolve remaining like a manually resolved file
- **THEN** the request for each remaining file contains that manual resolution as a worked example and the result is labelled as guided by that file

#### Scenario: Retry after failed check
- **WHEN** the user chooses Ask AI to fix after a failed post-resolution check
- **THEN** the request contains the check command and its output tail, and at most one such retry is performed per resolution

### Requirement: Resolved files are staged when configured
When the **Mark files as resolved automatically** setting is on, GitGood SHALL run the equivalent of `git add` on the resolved file after writing it, unless a post-resolution check is configured and failed, in which case the file SHALL stay resolved on disk but unstaged. Otherwise the file SHALL remain unstaged for the user to mark resolved.

#### Scenario: Auto-stage on
- **WHEN** the setting is on, no check is configured, and a resolution succeeds
- **THEN** the file no longer appears as conflicted and the result reports it as staged

#### Scenario: Auto-stage blocked by failed check
- **WHEN** the setting is on and the post-resolution check fails
- **THEN** the resolved content stays on disk, the file is not staged, and the result reports the failed check

### Requirement: Results are reported with confidence and can be undone
After a resolution GitGood SHALL show a toast with the rationale summary and, when any block is low confidence, the count of low-confidence blocks with the first rationale. The toast SHALL offer **Undo** (or **Undo all** for a multi-file run) which restores the original conflicted content and re-marks the file as unresolved in the index. In addition, the resolved file SHALL open in the diff pane with each resolved block's line range tinted by confidence (high, medium, low), a legend whose counts match the toast, and next/previous low-confidence navigation. The conflicts dialog SHALL show a per-file confidence summary and list files with any low-confidence block first.

#### Scenario: Low-confidence block
- **WHEN** at least one block was resolved with low confidence
- **THEN** the toast says how many blocks were flagged and shows the first rationale, and the block's range is outlined as low confidence in the diff pane

#### Scenario: Undo
- **WHEN** the user clicks Undo
- **THEN** the file content is restored to the original conflicted content and the index entry is unresolved

#### Scenario: Legend matches toast
- **WHEN** a file with two high, one medium and one low block is resolved
- **THEN** the legend shows counts 2, 1 and 1 and the toast reports one low-confidence block

#### Scenario: Tints cleared on external edit
- **WHEN** the resolved file changes on disk after the resolution
- **THEN** the confidence tints for that file are removed

## ADDED Requirements

### Requirement: Explain-why popover with per-block side selection
Each resolved block SHALL have a gutter badge that opens a popover showing the model's rationale and the original ours, theirs and base text (collapsible), with actions **Accept**, **Use ours**, **Use theirs**, **Use base** (when a base exists) and **Edit in editor**. Choosing a side SHALL rewrite only that block from the pre-resolution snapshot, leave the file modified but not marked resolved until the user confirms, and SHALL be refused when the file on disk no longer matches the AI output.

#### Scenario: Use theirs for one block
- **WHEN** the user picks Use theirs in the popover for block 2 of a three-block file
- **THEN** only block 2's range is replaced with the theirs text, blocks 1 and 3 keep the AI resolution, and the file is shown as modified and unresolved

#### Scenario: File changed on disk
- **WHEN** the file content differs from the AI output when a side is chosen
- **THEN** the action is refused with a message that the file changed on disk

### Requirement: Post-resolution check runs a configured command
When a check command is configured, GitGood SHALL run it in the repository root after each successful AI resolution (single or all), with the same environment as git operations, no interactive prompts, a 5-minute timeout, and its output streamed into the progress toast. A passing check SHALL be reported as passed; a failing or timed-out check SHALL show a banner with the tail of the output, a **Show output** action and an **Ask AI to fix** action.

#### Scenario: Check passes
- **WHEN** the configured command exits with code 0
- **THEN** the toast reports Check passed and staging proceeds according to the auto-stage setting

#### Scenario: Check times out
- **WHEN** the command has not exited after 5 minutes
- **THEN** it is killed and reported as failed with a timed-out reason

#### Scenario: No check configured
- **WHEN** neither the settings nor the repository provide a check command
- **THEN** no check runs and no check UI is shown

### Requirement: Repository-provided check commands require trust
A check command read from the repository's `.gitgood/config.json` SHALL take precedence over the user's setting only when the **allow repository check commands** setting is on, SHALL be labelled as coming from the repository, and SHALL NOT run until the user has confirmed it once for that repository after seeing the full command text and the file path. Declining SHALL disable repository commands for that repository until re-enabled.

#### Scenario: First run in a repository
- **WHEN** a repository provides a check command and the user has not trusted it
- **THEN** a confirmation shows the full command and file path and nothing runs until the user accepts

#### Scenario: Declined
- **WHEN** the user declines the confirmation
- **THEN** the repository command is not run now or later for that repository, and the user's own setting (if any) is used instead

### Requirement: Manual resolutions are captured as examples for the current operation
When the user marks a conflicted file as resolved after editing it or after per-block side selection, GitGood SHALL record the pair of original conflicted content and resolved content in memory for the current merge, rebase, cherry-pick or revert. The conflicts dialog SHALL offer **Resolve remaining like `<file>`** whenever at least one example exists and other text conflicts remain. Examples SHALL persist across rebase continue steps and SHALL be discarded when the operation completes or is aborted or the app exits, and SHALL never be written to disk.

#### Scenario: Offer appears after one manual resolution
- **WHEN** the user resolves one of three conflicted files by hand and marks it resolved
- **THEN** the conflicts dialog shows Resolve remaining like that file

#### Scenario: Examples cleared on abort
- **WHEN** the user aborts the merge
- **THEN** recorded examples are discarded and the guided action is no longer offered

#### Scenario: Single conflicted file
- **WHEN** only one file is conflicted
- **THEN** the guided action is not shown
