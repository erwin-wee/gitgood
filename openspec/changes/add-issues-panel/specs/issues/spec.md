# Spec Delta

## Purpose

Lets users browse, filter, view, create and reference GitHub issues for the current repository without leaving the app, so commit messages and branch names can cite the right issue in one click.

## ADDED Requirements

### Requirement: Issues dialog lists and filters issues
The system SHALL provide an Issues dialog for the current repository, reachable from the Repository menu, a keyboard shortcut and the commit form, that lists issues with a free-text search and filters for state (open, closed, all), assigned to me, created by me, mentioned, labels and milestone. Filter choices MUST be remembered per repository across app restarts.

#### Scenario: Filtered list loads
- **WHEN** the user opens the Issues dialog and enables the *Assigned to me* filter
- **THEN** the list shows only open issues assigned to the signed-in user, and the filter is still active the next time the dialog is opened for that repository

#### Scenario: Empty filter result
- **WHEN** no issue matches the active filters
- **THEN** the list shows an empty state describing the active filter (for example *No open issues assigned to you*) rather than a blank pane

#### Scenario: Loading more results
- **WHEN** the repository has more issues than the first page returned
- **THEN** the dialog offers a *Load more* action that appends older issues without duplicating those already shown

### Requirement: Issue detail with comments and actions
The system SHALL show the selected issue's title, body, labels, assignees, milestone and its latest comments, with the body rendered as plain text with clickable links only. The detail view MUST offer Open on GitHub, Copy link, Copy `#N`, Reference in commit, Create branch for issue, Close or Reopen, and Comment.

#### Scenario: Reference in commit
- **WHEN** the user clicks *Reference in commit* on issue 123
- **THEN** the text `Fixes #123` (or `Refs #123` when chosen) is appended to the commit description in the Changes tab without replacing existing text

#### Scenario: Create branch for issue
- **WHEN** the user clicks *Create branch for issue* on issue 123 titled "Fix login timeout"
- **THEN** the new-branch dialog opens pre-filled with `123-fix-login-timeout`, using only lowercase letters, digits and hyphens and at most 60 characters

#### Scenario: Body is never rendered as HTML
- **WHEN** an issue body contains HTML or Markdown markup
- **THEN** the markup is shown as text with URLs turned into links, and no HTML is executed or rendered

### Requirement: Close and reopen with confirmation
The system SHALL allow closing and reopening an issue from the detail view. Closing MUST ask for confirmation once, and the list MUST reflect the new state without a full reload.

#### Scenario: Close an issue
- **WHEN** the user clicks *Close* and confirms
- **THEN** the issue is closed on GitHub and its row in the list updates to the closed state while other rows remain unchanged

#### Scenario: Reopen an issue
- **WHEN** the user clicks *Reopen* on a closed issue
- **THEN** the issue is reopened on GitHub and the row updates to the open state

### Requirement: Create issues from templates
The system SHALL let the user create an issue with a title, body, labels and assignees. When the repository has issue templates, the form MUST offer them in a dropdown and pre-fill title, body and labels from the chosen template.

#### Scenario: Create with template
- **WHEN** the user picks the "Bug report" template, fills in the title and clicks *Create*
- **THEN** an issue is created on GitHub with the template body, its labels and the chosen assignees, and a toast links to the new issue

#### Scenario: Template front matter parsed
- **WHEN** a template file declares `name`, `about`, `title` and `labels` in YAML front matter
- **THEN** the dropdown shows `name` and `about`, and selecting it pre-fills `title` and `labels`, with the front matter stripped from the body

### Requirement: Degraded and error states
The system SHALL show an explanatory panel instead of an empty or broken list when issues are disabled on the repository, when the user is not signed in to GitHub, when the GitHub CLI is unavailable, or when the API is rate-limited.

#### Scenario: Issues disabled on repository
- **WHEN** the repository has issues disabled
- **THEN** the dialog explains that issues are disabled and links to the repository settings page

#### Scenario: Signed out
- **WHEN** the user is not signed in to GitHub
- **THEN** the dialog shows the same sign-in card used by the Pull Requests dialog

#### Scenario: Rate limited
- **WHEN** GitHub returns a rate-limit error
- **THEN** the dialog shows the time the limit resets and pauses automatic list refreshes until then

### Requirement: Fork handling
The system SHALL, when the current repository is a fork, offer a toggle to show the parent repository's issues, since issues normally live on the parent.

#### Scenario: Fork toggle
- **WHEN** the repository is a fork and the user enables *Show parent repository issues*
- **THEN** the list and all actions target the parent repository's issues
