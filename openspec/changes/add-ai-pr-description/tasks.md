# Tasks

## 1. Data gathering

- [x] 1.1 Add `mergeBase(git, repoPath, a, b)` to `src/main/git/log.ts` and verify it against a temp repo in `test/main-parsers.test.ts`
- [x] 1.2 Add `getRangePatch(git, repoPath, base, head, maxBytes)` in `src/main/git/diff.ts` returning stat, patch and a truncated flag; verify the byte cap and flag with a unit test
- [x] 1.3 Add `GhClient.issueView(ref, number)` in `src/main/gh/gh.ts` that returns `{ number, title, state }` or null when unauthenticated; verify with a stubbed `gh` on PATH

## 2. Draft service and contract

- [x] 2.1 Add `PrDraftInput`, `PrDraft` to `src/shared/types.ts` and `ai.prDraft` to `src/shared/ipc.ts`; verify `npm run typecheck`
- [x] 2.2 Add `PR_DRAFT_SCHEMA`, `PR_DRAFT_SYSTEM_PROMPT` and `buildPrDraftPrompt` to `src/main/ai/prompts.ts`; verify the schema validates a sample response in a unit test
- [x] 2.3 Implement `src/main/ai/prDraft.ts`: gather inputs with caps, call the backend, normalize title, enforce template headings, filter and downgrade issue links, strip wrapping fences, cap body; verify with `test/pr-draft.test.ts` covering reference extraction (including code spans and `owner/repo#N`), heading preservation and restoration, title normalization and the keyword downgrade rule
- [x] 2.4 Register the handler in `src/main/ipc.ts`, emit `ai.progress` with path `<pull request>` and honour `ai.cancel`; verify cancellation restores no partial state by unit-testing the abort path

## 3. UI

- [x] 3.1 Add the Draft with AI button, tooltip states (provider disabled hidden, no commits ahead, base missing) and read-only-while-loading behaviour to `CreatePullRequestDialog` in `GitHubDialogs.tsx`; verify visually in a smoke screenshot
- [x] 3.2 Add the Replace / Keep mine / Append prompt and the "AI drafted, review before creating" callout with "Template structure restored" variant; verify by driving `window.__gitgood.actions.draftPullRequest()` with a stubbed backend and dumping the dialog state
- [x] 3.3 Append the AI footer on create when `reviewPostFooter` is on and the body still originates from the draft; verify with a unit test on the body assembly helper
- [x] 3.4 Add the Branch menu entry in `src/main/menu.ts` and the menu action case in `state/actions.ts`; verify the menu opens the dialog and starts the draft
- [x] 3.5 Show the first-use disclosure notice (shared with PR review) before the first draft; verify the notice appears once and is persisted as dismissed

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass: fixture repo with two commits ahead of main and a template; run the draft with a stubbed backend, assert all template headings are present in the dumped body and take a screenshot of the dialog
- [x] 4.3 Update README Features and the AI section to mention PR description drafting
