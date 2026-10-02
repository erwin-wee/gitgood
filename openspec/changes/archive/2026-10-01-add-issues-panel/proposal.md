# Proposal

## Why

Developers leave GitGood for the browser every time they need an issue number for a commit message or a branch name. The GitHub CLI already exposes issues, and the app already has a commit form and a *Create issue* link to build on.

## What Changes

- Add an **Issues** dialog for the current GitHub repository: list open/closed issues with search and filters (assigned to me, created by me, mentioned, labels, milestone), remembered per repository.
- Show issue detail: title, body as linkified plain text, labels, assignees, milestone, and the latest comments.
- One-click actions: open on GitHub, copy link, copy `#N`, **Reference in commit** (appends `Fixes #N` / `Refs #N` to the commit description), **Create branch for issue** (pre-fills the new-branch dialog), close/reopen with confirmation, comment.
- Create issues from a form pre-filled from repository issue templates, with labels and assignees.
- Explanatory panels when issues are disabled on the repository, when the user is signed out, or when rate-limited.

## Capabilities

### New Capabilities
- `issues`: browsing, filtering, viewing, creating and referencing GitHub issues for the current repository from inside the app.

### Modified Capabilities
- (none; the commit form and new-branch dialog gain entry points but their existing requirements do not change.)

## Impact

- `gh` commands: `gh issue list --json …`, `gh issue view --json …,comments`, `gh issue create --body-file -`, `gh issue close|reopen`, `gh issue comment --body-file -`, `gh label list --json`, `gh api repos/{owner}/{repo}/milestones`.
- Reads `.github/ISSUE_TEMPLATE/*.md` and `.github/ISSUE_TEMPLATE.md` from the working tree.
- Code: `src/main/gh/gh.ts` (new issue, label and milestone wrappers), `src/shared/types.ts` and `src/shared/ipc.ts` (issue types and methods), `src/main/store.ts` (per-repository filter persistence), renderer dialogs, commit form, branch dialog and menu (`src/main/menu.ts`).
- Closing/reopening an issue and creating an issue or comment are outward-facing actions and happen only on explicit user action; closing asks for confirmation once.
