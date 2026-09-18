# Tasks

## 1. Patch and context inputs

- [x] 1.1 Extend `getPatchForFiles` in `src/main/git/diff.ts` to accept partial patches and synthesize untracked-file patches; verify the output parses round-trip through `parseUnifiedDiffs` in a unit test
- [x] 1.2 Export the worktree reader from `diff.ts` and add a nearby-tests helper using `git ls-files`; verify the cap of 200 paths in a unit test
- [x] 1.3 Add per-file `git hash-object` and temp-index tree hash helpers for staleness; verify hashes change when a file is edited in a temp repo

## 2. Review engine extension

- [x] 2.1 Add the worktree target variant, `ai.review.startWorktree`, `ai.review.applySuggestion` and `AiSettings.reviewBeforeCommit` (default false) to shared types, IPC and the settings merge; verify `npm run typecheck`
- [x] 2.2 Extend the per-file schema and prompt in `src/main/ai/prompts.ts` with the commit summary input and `commitMessageMatches`/`commitMessageNote`; verify a sample response validates
- [x] 2.3 Implement the worktree run in `src/main/ai/review.ts` (amend against HEAD~1, index during merge, untracked numbering, shared validation and skip rules); verify with `test/review.test.ts` that partial-patch annotation numbering equals `buildStagePatch` numbering and untracked files use file line numbers
- [x] 2.4 Implement `applySuggestion` with hash check and EOL preservation; verify unit tests for refusal on hash mismatch and CRLF round-trip

## 3. UI

- [x] 3.1 Add the Review changes action, findings strip and stale styling to `ChangesTab.tsx`; verify with a smoke screenshot
- [x] 3.2 Wire gutter markers and finding cards in `TextDiff.tsx` for the worktree run, with Dismiss, Copy, Open in editor and Apply to file (hidden for partial files); verify by driving `window.__gitgood.actions.reviewChanges()` with a stubbed run and dumping the store
- [x] 3.3 Highlight the Commit button when blockers exist and show the intent-mismatch note next to the summary; verify the button still commits in the smoke script
- [ ] 3.4 Implement staleness on file change and Re-review of stale files only; verify by editing a fixture file during the smoke run and asserting only that file is re-sent
- [x] 3.5 Add the Review before every commit setting to `SettingsDialog.tsx` and the Commit anyway / Go back dialog; verify Go back leaves status unchanged

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass on a fixture with `console.log('debug')` and a hard-coded token; assert two findings and a highlighted Commit button in the screenshot
- [x] 4.3 Update README Features and AI sections to mention pre-commit review
