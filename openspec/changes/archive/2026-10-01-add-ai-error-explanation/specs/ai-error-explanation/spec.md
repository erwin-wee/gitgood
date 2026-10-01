# Spec Delta

## Purpose

Explains a failed git or GitHub operation in plain language and offers fixes that map only onto actions GitGood already provides, so the user gets a next step without leaving the error dialog.

## ADDED Requirements

### Requirement: Explanation is offered for eligible errors only
The error dialog SHALL show a collapsed **Explain with AI** row when an AI provider is configured and the error is not one that already has a dedicated guided flow (conflicts, authentication failure, GitHub not signed in, AI not configured, cancelled). The row SHALL be absent when the provider is `disabled`.

#### Scenario: Unknown error
- **WHEN** a push fails with an unclassified error
- **THEN** the dialog shows the raw output and a collapsed Explain with AI row

#### Scenario: Error with dedicated flow
- **WHEN** an operation stops with conflicts
- **THEN** the conflicts flow opens and no Explain with AI row is shown

#### Scenario: Provider disabled
- **WHEN** the AI provider is `disabled`
- **THEN** the error dialog has no Explain with AI row

### Requirement: Explanation content and structure
On request GitGood SHALL show, inside the dialog, a one- or two-sentence **What happened**, a **Likely cause**, and up to three **Suggested fixes** ordered from least to most destructive. The request SHALL be cancellable and a backend failure SHALL show a retry affordance while keeping the raw output visible. When the explanation yields no valid fixes, only the explanation text SHALL be shown.

#### Scenario: Successful explanation
- **WHEN** the model responds
- **THEN** the dialog shows what happened, the likely cause and the fix buttons without closing

#### Scenario: Backend failure
- **WHEN** the AI request fails
- **THEN** the row shows that no explanation could be obtained and offers Retry

### Requirement: Fixes map only onto known actions
Each fix SHALL either name an action from a fixed set (fetch, pull, fetch and pull, push with upstream, force push with lease, stash and retry, discard and retry, remove stale lock file, abort merge/rebase/cherry-pick/revert, continue rebase, open sign-in, open remote settings, open identity settings, rename branch, open in terminal) or be copy-only with a single `git` or `gh` command. A fix naming an unknown action SHALL become copy-only if it has a command and SHALL be dropped otherwise. Copy-only commands containing shell operators or not starting with `git ` or `gh ` SHALL be dropped. At most three fixes SHALL be kept and text fields SHALL be capped at 500 characters.

#### Scenario: Unknown action with command
- **WHEN** a fix names an action outside the set but includes `git fetch --prune`
- **THEN** it is shown as a copy-only fix

#### Scenario: Chained command
- **WHEN** a copy-only fix contains `git fetch && git pull`
- **THEN** the fix is dropped

### Requirement: Fixes respect repository state and risk
Fixes whose action does not apply to the current repository state SHALL be dropped (for example continue rebase when no rebase is in progress, or push with upstream when an upstream exists). The risk shown for an action fix SHALL be the higher of the model's classification and the action map's own classification. A fix flagged to retry the original operation SHALL only do so when the failed operation is retryable.

#### Scenario: Inapplicable fix
- **WHEN** the model suggests continue rebase and no rebase is in progress
- **THEN** that fix is not shown

#### Scenario: Risk override
- **WHEN** the model labels force push with lease as safe
- **THEN** the fix is shown as touching the remote

### Requirement: Fix execution goes through existing operations and confirmations
Clicking an action fix SHALL close the dialog and run the mapped operation through the same path as the manual action, including its confirmation dialogs (force push, discard). Copy-only fixes SHALL offer a copy action and **Run in terminal**, which opens the configured shell at the repository without executing the command. No fix SHALL run automatically. The remove-lock-file fix SHALL refuse when a git process is running or the lock file is younger than 10 seconds, and SHALL require confirmation otherwise.

#### Scenario: Publish branch fix
- **WHEN** the user clicks the push with upstream fix after a no-upstream failure
- **THEN** the push runs with set-upstream and, if the original operation was retryable, it is retried after success

#### Scenario: Run in terminal
- **WHEN** the user clicks Run in terminal on a copy-only fix
- **THEN** the shell opens at the repository and the command is not executed

#### Scenario: Fresh lock file
- **WHEN** `.git/index.lock` is younger than 10 seconds or a git process is running
- **THEN** the remove-lock-file fix refuses and explains why

### Requirement: Diagnostic output is scrubbed before it leaves the process
Before stderr, stdout or commands are sent to the model, GitHub tokens, bearer tokens, URL user info and API key values SHALL be masked, and each stream SHALL be limited to its last 4,000 characters. Remote information sent SHALL include names and hosts only.

#### Scenario: Token in stderr
- **WHEN** stderr contains a `ghp_` token or an `https://user:password@host` URL
- **THEN** the prompt contains masked placeholders instead of the secret values

### Requirement: Automatic explanation is limited to unclassified errors
When the **explain errors automatically** setting is on, the explanation SHALL load as soon as the dialog opens only for unclassified errors; classified errors SHALL still require the explicit click. When offline, the row SHALL say the app appears to be offline and SHALL NOT retry automatically.

#### Scenario: Automatic mode on classified error
- **WHEN** the setting is on and a non-fast-forward push fails
- **THEN** the row stays collapsed until clicked

#### Scenario: Offline
- **WHEN** the AI request fails with a network error
- **THEN** the row reports that the app appears to be offline and does not retry on its own
