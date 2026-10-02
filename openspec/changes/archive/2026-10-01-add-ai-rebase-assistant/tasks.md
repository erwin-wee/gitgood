# Tasks

## 1. Inputs and validation

- [x] 1.1 Add per-commit stat and pushed-flag gathering for a range in `src/main/git/log.ts`, reusing `getCommitPatch` from the explain change (or adding it if absent); verify caps of 60 commits and 8,000/120,000 bytes in a unit test
- [x] 1.2 Create `src/main/ai/rebasePlan.ts` with plan validation (completeness, duplicates, squash target rules, trailer preservation, drop downgrade, caps, nothing-to-do); verify with `test/rebase-plan.test.ts`

## 2. Contract and service

- [x] 2.1 Add `RebasePlanAction`, `RebasePlanRow`, `RebasePlan`, `RebaseApplyProgress`, `ai.rebase.plan/apply/undo` and the `ai.rebase.progress` event; verify `npm run typecheck`
- [x] 2.2 Add the rebase plan schema and prompt to `src/main/ai/prompts.ts`; verify a sample response validates
- [x] 2.3 Implement planning: base resolution, merge detection via `listTodo`, dirty-tree check, backend call, validation, start SHA recording; verify with a stubbed backend in a unit test
- [x] 2.4 Implement the step applier in `src/main/git/operations.ts`: drops, rewords, reorders, squashes with SHA remapping by (author date, message) and progress events; verify against a temp repo with real git that a plan with one of each action yields the previewed `git log`
- [x] 2.5 Implement conflict hand-off (outcome `conflicts`), abort-to-start and undo; verify the abort path restores HEAD in the temp-repo test

## 3. UI

- [x] 3.1 Add Branch menu and History context menu entries with hidden/not-actionable states and the uncommitted-changes hand-off; verify in a smoke screenshot
- [x] 3.2 Build the pre-flight (editable base, counts, pushed warning, signing warning); verify the pushed count in the smoke dump
- [x] 3.3 Build the plan dialog with action selector, message editor, drag reorder, reset, rationale, pushed indicator and Preview result; verify by driving `window.__gitgood.actions.tidyBranch()` with a stubbed plan and dumping the edited plan
- [x] 3.4 Wire apply progress, non-dismissible applying state, conflicts banner hand-off, completion toast with Undo and the force-push reminder; verify in the smoke run

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass: fixture branch with "wip" and "fix typo" commits, stubbed plan, screenshot the dialog, apply, dump history and assert it matches the preview
- [x] 4.3 Update README Features and AI sections to mention Tidy up branch
