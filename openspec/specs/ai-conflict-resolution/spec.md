# ai-conflict-resolution Specification

## Purpose

One-click AI resolution of textual merge conflicts: the user picks a conflicted file (or all of them) and GitGood asks the configured model to reconcile every conflict block, writes the result, optionally marks the file resolved, and lets the user review or undo it.

## Requirements

### Requirement: AI resolution is offered for textual conflicts only
The conflicts dialog SHALL offer a per-file **Resolve with AI** action and a **Resolve all with AI** action only when an AI provider is configured and the file's conflict is a both-modified or both-added text conflict. Conflicts without text markers (for example delete/modify or binary) SHALL be refused with a message directing the user to pick a side.

#### Scenario: Provider disabled
- **WHEN** the AI provider setting is `disabled`
- **THEN** no AI resolution actions are shown in the conflicts dialog

#### Scenario: Conflict without markers
- **WHEN** the user requests AI resolution for a delete/modify conflict
- **THEN** the request fails with a message that the conflict has no text markers and that Use ours / Use theirs should be used instead

#### Scenario: Malformed markers
- **WHEN** the file contains conflict markers that cannot be parsed into blocks
- **THEN** the request fails asking the user to resolve the file manually and the file is left unchanged

### Requirement: Provider, model and effort are configurable
The user SHALL be able to choose the AI provider (Anthropic API with a stored key, or the Claude Code CLI using the user's existing sign-in), the model, and an effort level from low to max. The API key SHALL be stored encrypted with the operating system credential store and SHALL never be sent to the renderer. A **Test connection** action SHALL report whether the configured backend responds.

#### Scenario: Claude Code CLI provider
- **WHEN** the provider is the Claude Code CLI and the user is signed in to Claude Code
- **THEN** resolutions run headless with tools disabled, using a JSON schema for the output, and no API key is required

#### Scenario: API key missing
- **WHEN** the provider is the Anthropic API and no key is stored, no environment key exists and no local auth profile exists
- **THEN** the resolution fails with a not-configured error pointing to Options → AI

### Requirement: Each conflict block receives a structured resolution
For each conflict block GitGood SHALL send the block (ours, theirs and base when diff3 markers are present) with surrounding context, the in-progress operation (merge, rebase, cherry-pick or revert), branch names and recent commit subjects on both sides, and SHALL request a JSON answer containing, per block, the replacement text, a one-sentence rationale and a confidence of high, medium or low.

#### Scenario: diff3 markers
- **WHEN** the conflicted file uses diff3 or zdiff3 markers with a base section
- **THEN** the base text is included in the request for that block

#### Scenario: Complete answer
- **WHEN** the model answers with one resolution per block
- **THEN** every block is replaced by its resolution and the rationale and confidence are kept for display

### Requirement: Model output is validated before it is written
GitGood SHALL reject the whole resolution when any block's replacement still contains conflict markers, when the response does not match the schema, or when any block is missing a resolution. Resolutions for block ids not present in the file SHALL be ignored.

#### Scenario: Markers remain
- **WHEN** a returned resolution contains a `<<<<<<<`, `=======` or `>>>>>>>` line
- **THEN** the file is left unchanged and the error names the offending block

#### Scenario: Missing block
- **WHEN** the model omits a resolution for one of the blocks
- **THEN** the file is left unchanged and the error lists the unresolved block ids

### Requirement: Written files preserve formatting and detect concurrent edits
The resolved file SHALL preserve the original line endings and the text outside the conflict blocks byte for byte. If the file on disk changed while the model was working, GitGood SHALL NOT write and SHALL report that the file changed.

#### Scenario: CRLF file
- **WHEN** the conflicted file uses CRLF line endings
- **THEN** the resolved file uses CRLF line endings throughout

#### Scenario: File edited during resolution
- **WHEN** the file content differs from the snapshot taken before the request
- **THEN** nothing is written and the user is told to try again

### Requirement: Resolved files are staged when configured
When the **Mark files as resolved automatically** setting is on, GitGood SHALL run the equivalent of `git add` on the resolved file after writing it; otherwise the file SHALL remain unstaged for the user to mark resolved.

#### Scenario: Auto-stage on
- **WHEN** the setting is on and a resolution succeeds
- **THEN** the file no longer appears as conflicted and the result reports it as staged

### Requirement: Results are reported with confidence and can be undone
After a resolution GitGood SHALL show a toast with the rationale summary and, when any block is low confidence, the count of low-confidence blocks with the first rationale. The toast SHALL offer **Undo** (or **Undo all** for a multi-file run) which restores the original conflicted content and re-marks the file as unresolved in the index.

#### Scenario: Low-confidence block
- **WHEN** at least one block was resolved with low confidence
- **THEN** the toast says how many blocks were flagged and shows the first rationale

#### Scenario: Undo
- **WHEN** the user clicks Undo
- **THEN** the file content is restored to the original conflicted content and the index entry is unresolved

### Requirement: Multi-file resolution runs with progress and cancellation
**Resolve all with AI** SHALL resolve every conflicted text file, a few at a time, reporting per-file progress (started, thinking, writing, done, error). A cancel action SHALL abort in-flight requests; files already written stay resolved and files not started are left conflicted. Per-file failures SHALL be reported individually without aborting the other files.

#### Scenario: Cancel mid-run
- **WHEN** the user cancels while some files are still pending
- **THEN** pending requests stop, completed files remain resolved, and the remaining files remain conflicted

#### Scenario: One file fails
- **WHEN** one file's resolution is rejected by validation
- **THEN** that file is reported as failed and the other files are still resolved

### Requirement: Backend errors are classified and refusals fall back
AI failures SHALL be reported with a classified message (not configured, authentication, rate limit, refusal, truncated output, invalid output, network, cancelled). For models that support it, a server-side refusal fallback SHALL be enabled so a false-positive safety decline is retried on a fallback model within the same request; a final refusal SHALL be reported as such.

#### Scenario: Output truncated
- **WHEN** the model response stops because the output limit was reached
- **THEN** the user is told the response was cut off and to resolve fewer conflicts at once

#### Scenario: Refusal
- **WHEN** the model declines to resolve the file after any fallback
- **THEN** the user is told the model declined and to resolve manually or try another model
