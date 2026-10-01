# Spec Delta

## Purpose

Explains a commit, a file's changes or a selected range of lines in plain language, so an engineer who did not write the change can understand what it does and what to check.

## ADDED Requirements

### Requirement: Explain entry points
The system SHALL offer Explain for a selected commit in History (header button and context menu), for the selected file's diff in History and Changes (diff pane header), and for a selected range of lines in a text diff (context menu). All entry points SHALL be hidden when the AI provider is disabled. For binary, image, submodule or too-large diffs the file-level entry SHALL be shown as not actionable with the reason.

#### Scenario: Commit in History
- **WHEN** the provider is enabled and a commit is selected in History
- **THEN** an Explain commit action is available in the commit header and the commit context menu

#### Scenario: Selected lines
- **WHEN** the user selects a range of lines in a text diff and opens the context menu
- **THEN** an Explain selected lines action is available

#### Scenario: Binary file
- **WHEN** the selected file's diff is binary
- **THEN** the Explain action for the file is not actionable and shows "Nothing to explain"

#### Scenario: Provider disabled
- **WHEN** the provider setting is `disabled`
- **THEN** no Explain action is rendered anywhere

### Requirement: Explanation content and structure
An explanation SHALL be presented in four sections: What changed, Why (inferred), Impact and Watch out for. Inferred intent MUST be visibly separated from observed changes. The explanation MUST NOT restate the diff line by line. Text sections SHALL be capped at 2,000 characters each and Watch out for at 8 items. An explanation with an empty What changed section SHALL be rejected as invalid output.

#### Scenario: Successful explanation
- **WHEN** the user explains a commit that changes a default value
- **THEN** the panel shows the four sections and the impact section mentions the changed default

#### Scenario: Empty result
- **WHEN** the model returns an empty What changed section
- **THEN** the panel shows an error with Retry and no partial explanation is rendered

### Requirement: Line references resolve to the diff
References in the explanation SHALL be rendered as path and line links. Every rendered reference MUST point at a path in the explained target and at a line present on the new side of the visible diff, or carry no line. References that fail this check SHALL be removed. Clicking a reference SHALL scroll the diff to that line.

#### Scenario: Valid reference
- **WHEN** the explanation references a line that exists in the diff
- **THEN** the reference is rendered as a link and clicking it scrolls the diff to that line

#### Scenario: Invalid reference
- **WHEN** the model returns a reference to a path not in the target or a line not in the diff
- **THEN** that reference is not rendered

### Requirement: Scope-specific context
For a commit, the explanation SHALL use the commit message, author, date, changed files, per-file patches and up to five recent commits per file. For a file, it SHALL use the loaded diff and the new-side content when available. For a range, it SHALL use the selected lines with surrounding context from both sides. Merge commits SHALL be explained against their first parent and identified as merges; root commits SHALL be explained against the empty tree; renamed files SHALL be referenced by their new path.

#### Scenario: Merge commit
- **WHEN** the user explains a merge commit
- **THEN** the explanation is produced from the diff against the first parent and states the commit is a merge

#### Scenario: Root commit
- **WHEN** the user explains the repository's first commit
- **THEN** the explanation states the files are new and no error occurs

#### Scenario: Renamed file
- **WHEN** the commit renames a file and edits it
- **THEN** references use the new path

### Requirement: Size limits and partial explanations
Input sent to the model SHALL be capped at 120,000 bytes; when a commit exceeds it, the largest files SHALL be truncated first, omitted files SHALL be listed to the model, and the panel SHALL show a partial badge. Binary files SHALL be described by name only.

#### Scenario: Huge commit
- **WHEN** a commit's patches exceed the byte cap
- **THEN** the explanation is produced from the truncated input and the panel shows a partial badge

### Requirement: Follow-up questions
The panel SHALL let the user ask up to five follow-up questions about the same target. Each follow-up SHALL reuse the original context and the previous answers. The counter of remaining turns SHALL be visible.

#### Scenario: Follow-up within limit
- **WHEN** the user asks "why was the null check removed?" after an explanation
- **THEN** an answer appears under the explanation and the remaining-turn counter decreases by one

#### Scenario: Limit reached
- **WHEN** five follow-ups have been asked
- **THEN** the input is not actionable and states the limit

### Requirement: Copy as Markdown
The panel SHALL offer Copy as Markdown, producing the four sections with the commit SHA (when the target is a commit) and the referenced paths, suitable for pasting into a pull request comment.

#### Scenario: Copy
- **WHEN** the user clicks Copy as Markdown on a commit explanation
- **THEN** the clipboard contains Markdown with the SHA, section headings and path references

### Requirement: Loading, cancellation and errors
While an explanation is in progress the panel SHALL show a loading state and a Cancel action. Cancelling SHALL return the panel to idle. A backend error SHALL show the classified message with Retry. No repository content SHALL be written and no GitHub call SHALL be made by this capability.

#### Scenario: Cancel
- **WHEN** the user cancels a running explanation
- **THEN** the call is aborted and the panel returns to idle

#### Scenario: Backend error
- **WHEN** the backend fails with a network error
- **THEN** the panel shows the error message and a Retry action
