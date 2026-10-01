# Spec Delta

## Purpose

Gives each open pull request a short AI-written triage line and a deterministic state so the user can see at a glance what a PR does, who it is waiting on and what to do next.

## ADDED Requirements

### Requirement: Triage lines appear in the pull request list
Each pull request row SHALL show a triage line (state chip plus one-sentence summary, at most 140 characters) when a cached line exists for the PR's current `updatedAt`, and an empty slot otherwise. Hovering the line SHALL show the full summary and the reason for the state. Triage UI SHALL be absent when the AI provider is `disabled`.

#### Scenario: Cached line
- **WHEN** the PR dialog opens and a line is cached for the PR's current update time
- **THEN** the row shows the state chip and summary without any AI call

#### Scenario: Provider disabled
- **WHEN** the AI provider is `disabled`
- **THEN** no triage lines, buttons, filters or badges are shown

### Requirement: Summarize generates lines only for PRs without a fresh cache
The header SHALL offer **Summarize N pull requests** where N counts open PRs with no cached line for their current `updatedAt`. Running it SHALL request lines in batches of at most 15 PRs per model call, fill rows progressively, report progress, and be cancellable between batches. PRs missing from a batch response SHALL be retried once individually and otherwise marked as not summarized. A backend failure SHALL keep existing cached lines.

#### Scenario: Partial cache
- **WHEN** 20 PRs are open and 5 have fresh lines
- **THEN** the button reads Summarize 15 pull requests and running it requests exactly those 15

#### Scenario: Cancel between batches
- **WHEN** the user cancels after the first batch of a 40-PR run
- **THEN** the first 15 lines are kept and no further batch is requested

#### Scenario: Missing item
- **WHEN** the batch response omits one PR number
- **THEN** that PR is retried alone once and, if still missing, shown as not summarized

### Requirement: Inputs are metadata, not diffs
Requests SHALL include for each PR: number, title, body (capped at 1,500 characters), author, draft flag, base and head, head repository for cross-repository PRs, labels, review decision, review requests, latest reviews (author and state), checks summary with failing check names, mergeability, update time and age, and file statistics when the diff-stat setting is on (capped at 50 files). No diff content SHALL be sent. The signed-in login SHALL be included so the model can classify waiting-on-you.

#### Scenario: Diff stat off
- **WHEN** the include-diff-stat setting is off
- **THEN** the request contains no per-file statistics

#### Scenario: Fork PR
- **WHEN** a PR comes from a fork
- **THEN** the request names the head repository

### Requirement: Deterministic state rules override the model
Each PR's state SHALL be cross-checked in code: draft → draft; conflicting mergeability → conflicts; failing checks on the user's own PR → waiting on author; an explicit review request for the signed-in user → waiting on you; no activity for 14 days → stale. Where these rules are decisive the code value SHALL replace the model's. A next action of merge SHALL be downgraded to none unless the PR is mergeable, checks pass and the review decision is approved. Summaries SHALL be capped at 140 characters and reasons at 200.

#### Scenario: Draft mislabelled
- **WHEN** the model returns ready to merge for a draft PR
- **THEN** the row shows draft

#### Scenario: Merge downgraded
- **WHEN** the model suggests merge for a PR whose checks are failing
- **THEN** the next action is none

### Requirement: Waiting on you filter and badge agree
A **Waiting on you** toggle SHALL filter the list to PRs in that state and the dialog title SHALL show the count. The toolbar pull request button SHALL show the same count as a badge, updated when the PR poller refreshes.

#### Scenario: Two PRs waiting
- **WHEN** two open PRs are classified waiting on you
- **THEN** the filter shows exactly those two and the toolbar badge reads 2

### Requirement: Cache freshness and eviction
Lines SHALL be cached per repository and PR number keyed by `updatedAt`. When a PR's `updatedAt` changes, its line SHALL be shown dimmed as stale and refreshed on the next Summarize, or automatically when the auto-refresh setting is on. Entries for closed or merged PRs, and entries older than 30 days, SHALL be evicted. Cached lines SHALL be shown offline with Summarize disabled and a tooltip explaining why.

#### Scenario: PR updated
- **WHEN** the poller reports a new update time for a PR with a cached line
- **THEN** the line is dimmed and counted in the next Summarize

#### Scenario: PR merged
- **WHEN** a PR with a cached line is merged
- **THEN** its cache entry is removed

### Requirement: Next actions open existing flows only
Clicking a suggested next action (review, checkout, view checks, merge, rebase, ping author) SHALL open the corresponding existing dialog or action and SHALL NOT merge, review, comment or notify anyone by itself.

#### Scenario: Merge action
- **WHEN** the user clicks the merge next action
- **THEN** the existing merge dialog opens and nothing is merged until the user confirms there
