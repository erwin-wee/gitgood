# Spec Delta

## Purpose

Lets a user draft a pull request title and body with AI from the branch's commits, diff and PR template, so the Create pull request dialog starts filled in and only needs review.

## ADDED Requirements

### Requirement: Draft action availability
The Create pull request dialog SHALL offer a **Draft with AI** action next to the title field. The action SHALL be hidden when the AI provider is set to disabled, and SHALL be shown but not actionable, with an explanatory tooltip, when the head branch has no commits ahead of the base branch or when the base ref is not available locally.

#### Scenario: Provider disabled
- **WHEN** the AI provider setting is `disabled` and the user opens the Create pull request dialog
- **THEN** no Draft with AI action is rendered anywhere in the dialog

#### Scenario: No commits ahead of base
- **WHEN** the head branch has zero commits that are not on the base branch
- **THEN** the Draft with AI action is visible but not actionable and its tooltip says there is nothing to draft

#### Scenario: Base ref missing locally
- **WHEN** the selected base branch has no local ref (for example an unfetched fork upstream)
- **THEN** the action is not actionable and the tooltip says the base branch must be fetched first, and no fetch is started automatically

### Requirement: Draft content from commits and diff
On activation the system SHALL gather the commits ahead of the base branch, the combined diff against the merge base, the branch name and, when present, the repository's PR template, and SHALL produce a title and body from one AI call. The title SHALL be imperative, at most 72 characters when possible and never more than 256, with no trailing period. The body SHALL explain intent and notable decisions rather than list files.

#### Scenario: Successful draft
- **WHEN** the user activates Draft with AI on a branch with commits ahead of base and empty title and body fields
- **THEN** the title and body fields are filled with the drafted content and remain editable

#### Scenario: Title normalization
- **WHEN** the model returns a title with a trailing period or longer than 256 characters
- **THEN** the trailing period is removed and the title is truncated to 256 characters before it is shown

#### Scenario: Empty title from model
- **WHEN** the model returns an empty title
- **THEN** the draft is rejected as invalid output, the fields keep their previous values and an error toast is shown

### Requirement: Template preservation
When the repository has a PR template, the drafted body MUST contain every heading from the template in the original order, with each section filled with relevant content or the literal `_N/A_`. Checkboxes in the template SHALL be kept and ticked only when the diff clearly satisfies them. If the returned body violates the heading order, the system SHALL rebuild the body by placing the drafted paragraphs under the first heading and appending the rest of the template verbatim, and SHALL tell the user the template structure was restored.

#### Scenario: All headings survive
- **WHEN** the repository has a template with headings `## Summary`, `## Testing`, `## Checklist` and the user drafts
- **THEN** the body contains those three headings in that order and no heading is missing

#### Scenario: Model drops a heading
- **WHEN** the model returns a body that omits or reorders a template heading
- **THEN** the body is rebuilt with the template's headings in order and the callout reads "Template structure restored"

#### Scenario: Template with CRLF line endings
- **WHEN** the template file uses CRLF line endings
- **THEN** the drafted body uses the template's line endings

### Requirement: Issue linking from commits
The system SHALL extract issue references (`#N`, `Fixes #N`, `owner/repo#N`) from the commit messages, ignoring references inside code spans, and SHALL include only those references in the body. A reference SHALL use a closing keyword only when a commit message contains a closing keyword (`fix`, `fixes`, `fixed`, `close`, `closes`, `closed`, `resolve`, `resolves`, `resolved`) for that issue; otherwise it SHALL be included as a plain reference. When GitHub authentication is available, up to 5 distinct issue titles MAY be fetched to inform the body; when unavailable the draft SHALL still succeed without titles.

#### Scenario: Closing keyword in a commit
- **WHEN** a commit message contains "Fixes #42"
- **THEN** the body links issue 42 with a closing keyword

#### Scenario: Plain mention in a commit
- **WHEN** a commit message contains "see #17" and no commit uses a closing keyword for 17
- **THEN** the body references issue 17 without a closing keyword, even if the model proposed one

#### Scenario: Model invents an issue
- **WHEN** the model returns an issue number that appears in no commit message and not in the existing body
- **THEN** that issue is not included in the body

#### Scenario: Signed out of GitHub
- **WHEN** the GitHub CLI is not authenticated
- **THEN** the draft completes with issue numbers but without fetched issue titles

### Requirement: Protection of user-entered content
If the title or body already contains user-entered text when the draft finishes, the system MUST ask the user to Replace, Keep mine or Append before changing the fields.

#### Scenario: Existing content
- **WHEN** the user has typed a body and then activates Draft with AI
- **THEN** a prompt offers Replace, Keep mine and Append, and the fields change only according to the choice

#### Scenario: Append chosen
- **WHEN** the user chooses Append
- **THEN** the drafted body is added after the existing text and the existing title is kept unless it was empty

### Requirement: Progress, cancellation and failure handling
While drafting, the title and body fields SHALL be read-only, a progress indicator SHALL be shown and a Cancel action SHALL be available. Cancelling or a backend failure MUST restore the fields to their previous values, and a failure SHALL show the classified error message.

#### Scenario: Cancel during draft
- **WHEN** the user cancels while the draft is in progress
- **THEN** the AI call is aborted and the title and body show exactly what they showed before the draft started

#### Scenario: Backend error
- **WHEN** the AI backend returns an authentication, network or truncation error
- **THEN** a toast shows the classified message and the fields are restored

### Requirement: Size limits and disclosure
The diff sent to the model SHALL be capped at 120,000 bytes and flagged as truncated when cut; the commit list SHALL be capped at 100 entries and summarized to subjects only above 400 commits; the template SHALL be capped at 6,000 characters. The first time a user drafts, the system SHALL show a dismissable notice that the diff and commit messages are sent to the configured AI provider.

#### Scenario: Oversized diff
- **WHEN** the combined diff exceeds 120,000 bytes
- **THEN** the model receives the full stat, a truncated diff and a truncated flag, and the resulting draft is still accepted

#### Scenario: First use notice
- **WHEN** a user drafts for the first time on this installation
- **THEN** a dismissable notice states what data is sent to the provider

### Requirement: Attribution and no automatic submission
The drafted body SHALL show an "AI drafted, review before creating" callout that disappears once the user edits the body or creates the PR. When the AI footer setting is enabled and the body still originates from the draft at create time, the system SHALL append an AI-drafted footer. The draft MUST NOT create the pull request, mark it ready or request reviewers.

#### Scenario: Footer appended on create
- **WHEN** the footer setting is on, the body was drafted and the user clicks Create pull request
- **THEN** the created PR body ends with the AI-drafted footer

#### Scenario: Draft never submits
- **WHEN** the draft completes
- **THEN** no pull request exists on GitHub until the user clicks Create pull request
