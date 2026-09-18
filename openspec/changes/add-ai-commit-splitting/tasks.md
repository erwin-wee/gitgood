# Tasks

## 1. Hunk model and patch assembly

- [x] 1.1 Add a combined hunk selector to `src/shared/diff/patch.ts` (or compose `selectHunk` results) so one patch per file can hold several hunks; verify in `test/patch.test.ts` that the output equals `buildStagePatch` with a combined selector
- [x] 1.2 Create `src/main/ai/splitter.ts` with hunk id computation, plan validation (unknown ids, duplicates, whole-file overlap, unassigned bucket, empty summary placeholder, zero-or-one-commit detection); verify with `test/split.test.ts` — implemented as a pure `src/main/ai/splitter-core.ts` plus orchestration in `src/main/ai/splitter.ts`, per this repo's established AI-feature convention (a testable pure `*-core.ts` + a thin orchestration module), which the task/design text (both naming everything `splitter.ts`) predates

## 2. Contract and service

- [x] 2.1 Add `SplitHunk`, `SplitPlanCommit`, `SplitPlan`, `SplitApplyProgress` types, `ai.split.plan/apply/undo` methods and the `ai.split.progress` event; verify `npm run typecheck` — also added `SplitPreflight` and `ai.split.preflight` (fast, non-AI pre-flight summary), needed for the spec's "before calling the model" requirement; see design deviations in the final report
- [x] 2.2 Add the split schema and prompt to `src/main/ai/prompts.ts`; verify a sample response validates
- [x] 2.3 Implement plan: gather working diffs, compute ids and file hashes, record start SHA, call the backend, validate; verify with a stubbed backend in a unit test (`test/split-plan-stub.test.ts`, real git + the claude-cli stub)
- [x] 2.4 Implement apply: hash check, sequential `createCommit` with per-file partial patches and whole files, progress events, stop-on-failure with clean index; verify against a temp repo with real git that three hunks in two files become two commits and that a forced failure leaves the first commit and a clean index (`test/split-apply.test.ts`)
- [x] 2.5 Implement undo with `git reset --soft` and unstage; verify HEAD and working tree in the temp-repo test

## 3. UI

- [x] 3.1 Add the entry point to the commit form overflow menu and the Repository menu with hidden/not-actionable states; verify in a smoke screenshot — the Changes-tab entry point is fully dynamic (hidden/disabled/tooltip computed live); the Electron application-menu item follows this codebase's existing convention for every other repo-scoped menu entry (static item, gated at click time with a toast), see the report
- [x] 3.2 Build the pre-flight card including excluded items and the file-only option above 150,000 bytes; verify the file-only path sends no hunk bodies (unit test on the prompt builder) — see `buildSplitPrompt` tests in `test/split.test.ts`
- [x] 3.3 Build the plan dialog with drag between commits, reorder, merge, edit, delete, Not included bucket and diff preview; verify by driving `window.__gitgood.actions` with a stubbed plan and dumping the edited plan state — the exposed actions are named `openSplitDialog`/`moveHunkTo`/`moveWholeFileTo`/`reorderCommit`/`mergeCommitInto`/`updateCommitMessage`/`deleteCommit` rather than a single `splitCommits()` (no such action existed to name); exercised end to end in the `ai-split-commits` smoke scenario's `edit.json`/`replan.json` dumps
- [x] 3.4 Wire apply progress, the non-dismissible applying state, the completion toast with Undo all and the Re-propose path on staleness; verify in the smoke run

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass: fixture repo with a mixed change, stubbed two-commit plan, screenshot the dialog, apply, dump history and assert two commits with the planned messages (`test/smoke/scenarios/27-ai-split-commits.json`)
- [x] 4.3 Update README Features and AI sections to mention commit splitting
