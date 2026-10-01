# Proposal

## Why

Opening a pull request in GitGood still means writing the title and body by hand, even though the app already holds the commits, the diff against the base branch and the repository's PR template. A one-click draft removes the most tedious step between finishing a branch and getting it reviewed.

## What Changes

- Add a **Draft with AI** action to the Create pull request dialog (and a Branch menu entry that opens the dialog and triggers it) that fills the title and body from the commits and diff ahead of the base branch.
- When the repository has a PR template, the draft fills the template's sections in order instead of replacing the template.
- Issue references found in commit messages are carried into the body, as closing keywords only when a commit uses a closing keyword.
- If the user has already typed content, the draft asks to Replace, Keep or Append rather than overwriting.
- Drafted bodies carry an AI-assisted callout in the dialog and, when the shared footer setting is on, an AI-drafted footer on create.
- Nothing is submitted to GitHub by the draft itself; the existing Create button remains the only write path.

## Capabilities

### New Capabilities
- `ai-pr-description`: drafting a pull request title and body with AI from the branch's commits, diff and PR template, including issue linking, template preservation and user-content protection.

### Modified Capabilities
<!-- none: the existing Create pull request flow keeps its requirements; the draft only fills editable fields -->

## Impact

- Git commands: `git merge-base <base> <head>`, `git log --format=... <base>..<head>`, `git diff --no-color --no-ext-diff -M --stat=120 <mb>...<head>`, `git diff --no-color --no-ext-diff -M <mb>...<head>`.
- GitHub CLI: `gh issue view N --repo owner/repo --json number,title,state` (optional, capped at 5; skipped when signed out). The existing PR template lookup is reused.
- AI backend: one structured JSON call through the shared backend (`src/main/ai/backends.ts`), new prompt and schema in `src/main/ai/prompts.ts`, new service module next to `resolver.ts`.
- Code touched: `src/main/git/diff.ts`, `src/main/git/log.ts`, `src/main/gh/gh.ts`, `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/renderer/src/components/dialogs/GitHubDialogs.tsx`, `src/renderer/src/state/actions.ts`, `src/main/menu.ts`.
- No new runtime dependencies. Shares the `reviewPostFooter` setting introduced by `add-ai-pr-review`.
