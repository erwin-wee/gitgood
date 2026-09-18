# Spec Delta

## Purpose

Lets a developer ask the configured AI provider to review a pull request or the current branch and see validated, line-anchored findings inside the diff viewer, then optionally post selected findings as a GitHub review.

## ADDED Requirements

### Requirement: Review entry points
The system SHALL offer **Review with AI** on each open pull request in the pull request list, in the pull request detail view and in the Branch menu when the current branch has an open pull request, and SHALL offer **Review branch with AI** in the Create pull request dialog and the Branch menu. In-app entry points SHALL be hidden when the AI provider is set to disabled. When GitHub CLI authentication is unavailable or the repository has no GitHub remote, only branch review SHALL be offered.

#### Scenario: Provider disabled
- **WHEN** the AI provider setting is `disabled`
- **THEN** no Review with AI buttons or links are rendered in the pull request list, detail view or Create pull request dialog

#### Scenario: Native menu with provider disabled
- **WHEN** the user chooses Review Branch with AI from the native Branch menu while the provider is `disabled`
- **THEN** the system shows a notice pointing to Options → AI and does not start a review

#### Scenario: No GitHub access
- **WHEN** the repository has no GitHub remote or `gh` is not signed in
- **THEN** Review branch with AI is available and pull request review is not

### Requirement: Pre-flight plan
Before any data is sent, the system SHALL show a pre-flight card listing the files that will be reviewed, the files that will be skipped with a reason, the number of changed lines, and the configured provider, model, effort and strictness. The user SHALL be able to deselect files and SHALL confirm with Start or leave with Cancel. The first time a review is started the card SHALL state what data is sent to the provider.

#### Scenario: Skipped files listed
- **WHEN** the diff contains a lockfile, a binary file, a generated file, a minified asset or a file with more than 1,500 changed lines
- **THEN** each such file appears under skipped files with its reason and is not sent to the provider

#### Scenario: File cap
- **WHEN** the diff contains more files than the configured maximum
- **THEN** the pre-flight shows which files are excluded and lets the user choose the files to review

#### Scenario: Cancel pre-flight
- **WHEN** the user chooses Cancel on the pre-flight card
- **THEN** nothing is sent to the provider and no run is recorded

### Requirement: Review inputs
For a pull request review the system SHALL provide the model with the pull request title and body, commit subjects, base and head branch names, names of failing checks, up to three linked issues referenced in the body, repository review guidelines when present, and for each reviewed file its unified diff with new-side line numbers annotated on every line plus a bounded excerpt of surrounding head-side content. For a branch review the system SHALL use the diff of the merge base against the branch tip and the commit subjects on the branch, with no GitHub access.

#### Scenario: Branch review offline
- **WHEN** the network is unavailable and the user starts Review branch with AI
- **THEN** the diff, commit subjects and guidelines are gathered locally and the review runs if the provider is reachable

#### Scenario: Truncated input
- **WHEN** an input exceeds its size cap
- **THEN** it is truncated and the request is marked as truncated so the model knows context is partial

### Requirement: Structured findings
Each finding SHALL have a file path, a new-side line, an optional end line in the same hunk, a severity of blocker, warning or nit, a category, a title, a detail explanation, an optional replacement suggestion and a confidence. After all files are reviewed the system SHALL produce a one-paragraph summary and a suggested verdict of approve, comment or request changes; when any blocker finding survives, the suggested verdict SHALL be at least request changes.

#### Scenario: Verdict floor
- **WHEN** the surviving findings include at least one blocker
- **THEN** the suggested verdict shown is request changes, regardless of the model's summary output

### Requirement: Validation of model output
The system SHALL drop any finding whose line does not exist as an added or context line on the new side of the reviewed file's diff, remapping findings on deleted lines to the nearest following new-side line within three lines. The system SHALL drop findings with an end line before the start line or in a different hunk, SHALL strip code fences from suggestions and drop suggestions containing conflict markers, SHALL merge duplicate findings on the same path, line and title keeping the higher severity, SHALL enforce length limits on title and detail, and in strict mode SHALL drop low-confidence findings. The number of dropped candidates SHALL be shown to the user.

#### Scenario: Out-of-diff line dropped
- **WHEN** the model returns a finding on a line that is not part of the reviewed diff
- **THEN** the finding is not shown and the dropped count increases by one

#### Scenario: Deleted-line remap
- **WHEN** the model cites a deleted line and a new-side line exists within the following three lines
- **THEN** the finding is shown on that new-side line

#### Scenario: Fenced suggestion
- **WHEN** a suggestion arrives wrapped in a code fence
- **THEN** the fence is removed and the raw lines are kept

### Requirement: Progress and cancellation
The system SHALL show per-file progress while a review runs and SHALL let the user cancel. Findings collected before cancellation SHALL be kept and files not yet reviewed SHALL be marked cancelled.

#### Scenario: Cancel mid-run
- **WHEN** the user cancels after some files have been reviewed
- **THEN** the panel shows the findings for completed files and marks the remaining files as cancelled

#### Scenario: Provider error
- **WHEN** the provider returns an authentication, rate-limit or truncation error
- **THEN** the classified error is shown, completed findings remain visible and the panel is marked incomplete

### Requirement: Findings presentation
The review view SHALL show the summary, suggested verdict and counts by severity, a file list with a finding count per file, the diff of each file with one gutter marker per finding on the new side, and a findings panel. Selecting a finding SHALL scroll the diff to its line and open an inline card with the detail, the suggestion rendered against the current lines, Dismiss, Copy and, in pull request mode, a Post checkbox that defaults to checked for blockers and warnings and unchecked for nits. In branch mode the card SHALL offer Open in editor at the file and line instead of Post.

#### Scenario: Click finding
- **WHEN** the user clicks a finding in the panel
- **THEN** the diff scrolls to the finding's line and the inline card is shown

#### Scenario: Zero findings
- **WHEN** a review finishes with no surviving findings
- **THEN** the panel states that explicitly and the summary and suggested verdict are still shown

### Requirement: Dismissals and persistence
Runs SHALL be persisted per repository and target head commit, keeping the most recent five per repository. Dismissed findings SHALL stay hidden after the app restarts for the same head commit.

#### Scenario: Dismiss survives restart
- **WHEN** the user dismisses a finding, quits and reopens the app on the same head commit
- **THEN** the finding remains dismissed

### Requirement: Stale runs and re-review
When the pull request head commit or branch tip differs from the run's head commit, the review view SHALL show a stale banner with a Re-review action that reviews only files whose diff changed and carries findings over for unchanged files.

#### Scenario: Author pushes
- **WHEN** the pull request head commit changes after a run
- **THEN** the stale banner is shown and Re-review sends only the changed files to the provider

### Requirement: Posting a review to GitHub
Posting SHALL happen only after the user confirms a dialog that shows the verdict selector, an editable body pre-filled from the summary, the findings that will become inline comments and the AI-assisted footer. The system SHALL create exactly one GitHub review pinned to the run's head commit, with one inline comment per selected finding. When the signed-in user authored the pull request, only the comment verdict SHALL be offered. If the head commit has moved since the run, posting SHALL be refused and the stale banner shown. If GitHub rejects inline comment positions, the system SHALL retry once with the rejected comments moved into the review body. Branch reviews SHALL have no posting path.

#### Scenario: Post selected findings
- **WHEN** the user confirms posting with two findings selected and the request-changes verdict
- **THEN** one review is created on the pull request with that verdict, the edited body plus footer, and two inline comments on the findings' lines

#### Scenario: Own pull request
- **WHEN** the pull request author is the signed-in GitHub user
- **THEN** the verdict selector offers only comment

#### Scenario: Head moved before posting
- **WHEN** the pull request head commit differs from the run's head commit at post time
- **THEN** posting is refused and the stale banner is shown

#### Scenario: Rejected comment positions
- **WHEN** GitHub rejects the review because a comment position is invalid
- **THEN** the system retries once with those comments listed in the review body instead

### Requirement: Review settings
Options → AI SHALL expose review strictness (strict, balanced, thorough; default strict), the maximum number of files per run (default 40) and whether the AI-assisted footer is appended to posted reviews (default on).

#### Scenario: Strictness affects findings
- **WHEN** strictness is strict
- **THEN** only blocker and warning findings with medium or high confidence are shown

### Requirement: Data handling
The diff, pull request text, linked issue text and surrounding code SHALL be sent only to the configured provider. Paths SHALL be repository-relative POSIX paths as reported by git, and line numbering SHALL follow the parsed diff so CRLF files are handled consistently. For cross-repository pull requests, surrounding content SHALL be fetched from the head repository only for files of 200 KB or less and omitted otherwise.

#### Scenario: Fork pull request
- **WHEN** the pull request comes from a fork and a reviewed file is larger than 200 KB
- **THEN** the file is reviewed from its diff alone without surrounding content
