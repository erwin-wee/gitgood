# Tasks

## 1. Inputs

- [x] 1.1 Add `getCommitPatch(git, repoPath, sha, maxBytes)` to `src/main/git/log.ts` with largest-first truncation and an omitted-file list; verify the byte cap and ordering in a unit test against a temp repo
- [x] 1.2 Add a recent-history-per-file helper using `git log --max-count=5`; verify it returns at most five entries and tolerates missing parents

## 2. Explain service and contract

- [x] 2.1 Add `ExplainTarget`, `Explanation`, `ExplainReference`, `ExplainFollowUp` to `src/shared/types.ts` and `ai.explain`, `ai.explain.followUp` to `src/shared/ipc.ts`; verify `npm run typecheck`
- [x] 2.2 Add the explain and follow-up schemas and prompts to `src/main/ai/prompts.ts`; verify a sample response validates
- [x] 2.3 Implement `src/main/ai/explain.ts` for commit, file and range scopes with merge/root/rename handling, reference validation via `review-core`, caps and the in-memory cache; verify with `test/explain.test.ts` covering reference filtering, truncation ordering and the invalid-output rejection
- [x] 2.4 Register handlers in `src/main/ipc.ts` with `ai.cancel` support and enforce the five-turn follow-up limit; verify the limit with a unit test

## 3. UI

- [x] 3.1 Add the Explanation panel to `DiffPane.tsx` with loading, result, error/Retry, follow-up input with counter, Copy as Markdown and persisted width; verify with a smoke screenshot
- [x] 3.2 Add Explain entry points in the History commit header and context menu, the diff pane header, and the line-selection context menu, hidden when the provider is disabled and not actionable for binary/image/submodule/too-large diffs; verify each state in the smoke script
- [x] 3.3 Render references as links that scroll the diff to the line; verify by driving `window.__gitgood.actions.explainCommit(sha)` with a stubbed result and asserting the scroll target
- [x] 3.4 Implement Copy as Markdown; verify the output format in a unit test

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass: select a commit in a fixture repo, run the stubbed explanation, dump the store and assert four sections are present
- [x] 4.3 Update README Features and AI sections to mention Explain
