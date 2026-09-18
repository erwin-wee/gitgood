# Spec Delta

## Purpose

Proposes and applies a user-approved cleanup of the commits on the current branch (squash, reword, reorder, drop) so a branch is tidy before it becomes a pull request.

## ADDED Requirements

### Requirement: Entry points and preconditions
The Branch menu SHALL offer **Tidy up branch with AI** and the History context menu SHALL offer it for a multi-selection of commits. The action SHALL be hidden when the AI provider is disabled, and SHALL be not actionable with a reason when the current branch is the default branch or when merge commits are in the selected range. A dirty working tree SHALL trigger the existing uncommitted-changes handling (stash or cancel) before planning.

#### Scenario: Default branch
- **WHEN** the current branch is the repository's default branch
- **THEN** the action is not actionable and the reason names the default branch

#### Scenario: Merge commits in range
- **WHEN** the range between base and HEAD contains a merge commit
- **THEN** no AI call is made and a callout explains that merges cannot be rewritten

#### Scenario: Dirty working tree
- **WHEN** the user activates the action with uncommitted changes
- **THEN** the uncommitted-changes dialog offers to stash first, and planning starts only after the tree is clean

### Requirement: Pre-flight
Before proposing, the system SHALL show the base branch (default branch or the current branch's upstream, editable), the number of commits in range, and whether any of them are already on the remote, with a warning that applying will require a force push.

#### Scenario: Pushed commits in range
- **WHEN** three of six commits are on the remote
- **THEN** the pre-flight warns that three commits are on the remote and a force push will be needed

#### Scenario: Base not found
- **WHEN** the entered base ref does not exist
- **THEN** the base field shows an error and Propose is not actionable

### Requirement: Plan completeness and validity
Every commit in range MUST appear exactly once in the plan, oldest first. Commits the model omits SHALL be added as pick; unknown or duplicate entries SHALL be removed with a warning. A squash target MUST be an earlier row that is not dropped; otherwise the row becomes pick. Trailers present in an original message (for example Co-authored-by, Signed-off-by) MUST be present in the proposed message, re-appended if missing. A drop of a non-empty commit that is not part of a revert pair SHALL be downgraded to pick with a warning unless the user opts in. Summary lines SHALL be capped at 120 characters and bodies wrapped at 72. A plan that changes nothing SHALL be reported as "already tidy".

#### Scenario: Omitted commit
- **WHEN** the model's plan lacks one commit from the range
- **THEN** that commit appears in the plan as pick in its original position

#### Scenario: Invalid squash target
- **WHEN** a row squashes into a later row or into a dropped row
- **THEN** the row becomes pick and a warning is shown

#### Scenario: Trailer preserved
- **WHEN** the original message ends with a Co-authored-by trailer and the model's reword omits it
- **THEN** the proposed message contains the trailer

#### Scenario: Nothing to do
- **WHEN** every row is pick with unchanged order and messages
- **THEN** the dialog says the branch already looks tidy and offers no Apply

### Requirement: Editable plan with preview
The plan dialog SHALL show one row per commit with the action (pick, squash-into, reword, drop), original message, proposed message, rationale and a pushed indicator. The user SHALL be able to change actions, edit messages, drag to reorder and reset a row to its original. **Preview result** SHALL show the resulting commit list as History would render it, and Apply SHALL produce exactly the previewed history.

#### Scenario: Edit then apply
- **WHEN** the user changes a squash row to pick and edits another row's message, then applies
- **THEN** the resulting history keeps the un-squashed commit and uses the edited message

#### Scenario: Preview matches result
- **WHEN** the user opens Preview result and then applies
- **THEN** History shows the same commits, order and messages as the preview

### Requirement: Application, conflicts and undo
Apply SHALL rewrite history using the existing squash, reword, reorder and drop operations with step progress. A conflict during apply SHALL surface the standard conflicts banner with Continue and Abort; Abort MUST restore the branch to the recorded start commit. After completion, a toast SHALL offer **Undo** for ten minutes, which resets the branch to the start commit when the working tree is clean. When rewritten commits were on the remote, the toast SHALL remind the user that a force push with lease is needed and link to the existing force-push flow. Nothing is pushed by this capability.

#### Scenario: Conflict during reorder
- **WHEN** a reorder step produces a conflict
- **THEN** the conflicts banner appears and choosing Abort leaves HEAD at the recorded start commit

#### Scenario: Undo
- **WHEN** the user clicks Undo in the completion toast
- **THEN** HEAD is the recorded start commit and the working tree is clean

#### Scenario: Pushed commits rewritten
- **WHEN** the applied plan rewrote commits that were on the remote
- **THEN** the toast says a force push with lease is required and links to the force-push dialog

### Requirement: Safety warnings
When commit signing is enabled for the repository, the pre-flight SHALL warn that rewriting drops signatures. A commit-msg hook rejection during apply SHALL stop the sequence and show the hook output.

#### Scenario: Signing enabled
- **WHEN** commit signing is configured for the repository
- **THEN** the pre-flight shows a signatures warning

#### Scenario: Hook rejects a message
- **WHEN** a reword is rejected by a commit-msg hook
- **THEN** the apply stops at that step and the hook output is shown

### Requirement: Progress and cancellation
Planning SHALL show progress and be cancellable; cancelling SHALL leave the repository untouched. Planning input SHALL be capped at 60 commits with per-commit patch excerpts of at most 8,000 bytes and 120,000 bytes in total, flagged as truncated when cut.

#### Scenario: Cancel planning
- **WHEN** the user cancels while the plan is being proposed
- **THEN** no history is rewritten and the dialog closes
