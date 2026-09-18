# Proposal

## Why

Reviewing a pull request means leaving the app and reading a cold diff in the browser, and authors open pull requests with debug prints, secrets or missing tests still in them. GitGood already fetches PR metadata, checks and diffs and already has an AI backend with structured output, so a review step can close that loop inside the client.

## What Changes

- Add a **Review with AI** action for pull requests (from the PR list, PR detail and Branch menu) that returns structured findings anchored to files and lines, shown as gutter markers in the diff viewer and in a findings panel with a summary and a suggested verdict.
- Add a **Review branch with AI** action that reviews the current branch against its base locally, without GitHub access, from the Create pull request dialog and the Branch menu.
- Add an optional, user-confirmed **Post review to GitHub** step that turns selected findings into one GitHub review with inline comments and an AI-assisted footer.
- Add review settings (strictness, maximum files, footer) under Options → AI, a pre-flight card listing reviewed and skipped files, per-file progress with cancel, persistence of runs per head commit, a stale banner when the PR moves, and re-review of changed files only.
- Extend the pull request model with the head commit SHA and add pull request diff retrieval.

## Capabilities

### New Capabilities
- `ai-pr-review`: AI-assisted review of a pull request or local branch diff, with validated inline findings, dismiss/copy/post actions, run persistence and optional posting of a GitHub review.

### Modified Capabilities
<!-- none: existing pull request, diff viewer and AI conflict resolution behaviour is unchanged; this change only adds entry points -->

## Impact

- Commands: `gh pr view --json ... headRefOid`, `gh pr diff`, `gh api repos/{o}/{r}/pulls/N/files`, `gh api repos/{o}/{r}/contents/{path}?ref=`, `gh issue view`, `gh api user`, `gh api -X POST repos/{o}/{r}/pulls/N/reviews`; `git merge-base`, `git diff --no-color --unified=3 base...head`, `git log --format=%s base..head`, `git show head:path`.
- Main process: `src/main/ai/review.ts`, `src/main/ai/review-core.ts`, `src/main/ai/provider.ts` (backend factory shared with the conflict resolver), `src/main/ai/prompts.ts`, `src/main/gh/gh.ts`, `src/main/gh/prdiff.ts`, `src/main/git/diff.ts`, `src/main/ipc.ts`, `src/main/menu.ts`.
- Shared contract: new `ai.review.*`, `gh.pr.diff`, `gh.pr.fileDiff`, `repo.diff.range` methods and the `ai.review.progress` event in `src/shared/ipc.ts`; review types and `AiSettings` fields in `src/shared/types.ts`.
- Renderer: review view, dialogs, state module, gutter annotations in the text diff, toolbar and GitHub dialog entry points, settings dialog.
- Data sent to the configured AI provider: the diff, PR description, linked issue text and up to 400 lines of surrounding code per file. Posting to GitHub is always user-confirmed.
- No new runtime dependencies.
