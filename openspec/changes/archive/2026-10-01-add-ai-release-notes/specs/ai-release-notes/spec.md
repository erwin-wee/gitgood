# Spec Delta

## Purpose

Produces categorized, reference-checked release notes for a commit range and lets the user insert them into the changelog or publish a GitHub release from one dialog.

## ADDED Requirements

### Requirement: Release notes dialog and range selection
A **Release notes…** action SHALL be available from the Repository menu and from a tag's History context menu (as notes since the previous tag). The dialog SHALL offer From (default: latest tag reachable from HEAD, or the root commit with a note when no tag exists), To (default: HEAD), a version name (default: next patch of the From tag when it is semver, otherwise blank), an include-PR-titles option (on when the repository has a GitHub remote and the user is signed in), and an audience of users or developers. Generation SHALL be hidden when the AI provider is `disabled`, while a plain commit-list export SHALL remain available.

#### Scenario: Defaults with a semver tag
- **WHEN** the latest reachable tag is `v1.2.3`
- **THEN** From is `v1.2.3`, To is HEAD and the version field suggests `1.2.4`

#### Scenario: No tags
- **WHEN** the repository has no tags
- **THEN** From defaults to the root commit and the dialog says so

#### Scenario: Provider disabled
- **WHEN** the AI provider is `disabled`
- **THEN** Generate is hidden and Export commit list is still offered

### Requirement: Range preview lists commits and pull requests
The dialog SHALL list the non-merge commits in `from..to` with short SHA and subject, and the pull request numbers found from merge commit subjects and squash-merge subjects, counting each PR once. Ranges over 500 commits SHALL be reduced to subjects only, flagged as truncated, with a suggestion to narrow the range. An empty range SHALL disable Generate.

#### Scenario: Squash and merge PRs
- **WHEN** the range contains a merge commit for PR 12 and a squash commit whose subject ends in `(#13)`
- **THEN** the preview lists PRs 12 and 13 once each

#### Scenario: Large range
- **WHEN** the range contains more than 500 commits
- **THEN** only subjects are gathered, the result is marked truncated and the dialog suggests narrowing the range

### Requirement: Generated notes are categorized and reference-checked
Generation SHALL request sections limited to Breaking changes, Features, Fixes, Performance, Docs and Internal, each item citing at least one PR number or commit from the range. GitGood SHALL remove references not in the range, move items left without references to an **unreferenced** review list instead of showing them, merge duplicate sections, render sections in the fixed order, cap items at 200 characters, and list every commit or PR in range that no item cites so omissions are visible. The Markdown SHALL be assembled by GitGood from the validated sections with a version heading and date; the model SHALL NOT emit the document structure. Generation SHALL be cancellable and keep the preview list.

#### Scenario: Invalid reference removed
- **WHEN** an item cites `#999`, which is not in the range, and also cites `abc1234`, which is
- **THEN** the rendered bullet cites only `abc1234`

#### Scenario: Item without valid references
- **WHEN** an item's only reference is not in the range
- **THEN** the item is shown in the unreferenced review list, not in the notes

#### Scenario: Omitted commit surfaced
- **WHEN** a commit in the range is cited by no item
- **THEN** it appears in the unreferenced list with an Add action that appends a plain bullet for it

### Requirement: Editing, copying and inserting into the changelog
The result SHALL be editable as Markdown with a rendered preview toggle and a **Copy Markdown** action. **Insert into CHANGELOG.md** SHALL prepend the notes under the file's top heading, or create the file when absent, preserving the file's line endings, and SHALL then show the file in the Changes tab for the user to commit. Nothing SHALL be written without this explicit action.

#### Scenario: Existing changelog
- **WHEN** `CHANGELOG.md` exists with a top-level heading and CRLF line endings
- **THEN** the notes are inserted directly below that heading and the file keeps CRLF endings

#### Scenario: No changelog
- **WHEN** `CHANGELOG.md` does not exist
- **THEN** it is created with a top heading and the notes, and appears as a new file in Changes

### Requirement: GitHub release creation is explicit and defaults to draft
**Create GitHub release…** SHALL open a confirmation with the tag (existing or to be created at To), title, body from the editor, Draft (default on) and Pre-release options. When a release already exists for the tag, the dialog SHALL offer to open it instead of creating one. When the tag does not exist, the confirmation SHALL say the tag will be created at the To commit. The action SHALL be unavailable with a reason when GitHub CLI is not signed in. Success SHALL show a toast linking to the release.

#### Scenario: Draft release
- **WHEN** the user confirms with defaults
- **THEN** a draft release is created for the tag and the toast links to its URL

#### Scenario: Existing release
- **WHEN** a release already exists for the chosen tag
- **THEN** the dialog offers Open existing and does not create a duplicate

#### Scenario: Not signed in
- **WHEN** GitHub CLI is not authenticated
- **THEN** the release action is disabled and explains that sign-in is required
