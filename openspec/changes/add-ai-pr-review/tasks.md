# Tasks

## 1. Shared contract

- [x] 1.1 Add review types, `AiSettings` review fields with defaults and `PullRequest.headSha` to `src/shared/types.ts`; verify `npm run typecheck` passes
- [x] 1.2 Add `ai.review.*`, `gh.pr.diff`, `gh.pr.fileDiff`, `repo.diff.range` methods and the `ai.review.progress` event to `src/shared/ipc.ts`; verify typecheck passes
- [x] 1.3 Merge the new settings in `src/main/store.ts` so older settings files load; verify by loading a settings file without the fields

## 2. Main process

- [x] 2.1 Extract the backend factory to `src/main/ai/provider.ts` and use it from the conflict resolver; verify existing conflict resolution tests and typecheck pass
- [x] 2.2 Add per-file and summary schemas and prompts to `src/main/ai/prompts.ts`; verify schemas have no optional properties and enums match the types
- [x] 2.3 Implement `src/main/ai/review-core.ts` (annotation, validation, skip rules, payload builder, issue parsing); verify with `test/review.test.ts`
- [x] 2.4 Add `prDiff`, `prRefs`, `issueView`, `fileContents`, `createReview`, `viewerLogin` and `headRefOid` to `src/main/gh/gh.ts`, and `src/main/gh/prdiff.ts` splitting; verify with `test/main-parsers.test.ts`
- [x] 2.5 Add `getRangeFileDiff` and `readBlobText` to `src/main/git/diff.ts`; verify branch-mode diffs load in the smoke run
- [x] 2.6 Implement the review service `src/main/ai/review.ts` (plan, start with concurrency 3, get, dismiss, post, persistence, re-review, own-PR restriction, stale refusal, 422 retry); verify typecheck and a plan call in the smoke run
- [x] 2.7 Register handlers in `src/main/ipc.ts`, wire cancellation into `ai.cancel`, add Branch menu items and Ctrl+Shift+R in `src/main/menu.ts`; verify menu items appear and the shortcut fires the action

## 3. Renderer

- [x] 3.1 Add review state (`src/renderer/src/state/review.ts`) and actions exposed on `window.__gitgood.actions`; verify the smoke script can call them
- [x] 3.2 Build the pre-flight card and post-review dialog in `components/dialogs/ReviewDialogs.tsx`; verify the pre-flight screenshot lists files and skipped reasons
- [x] 3.3 Build `components/review/ReviewView.tsx` (file list with badges, collapsible findings panel, inline finding card) and `styles/review.css`; verify the review screenshot shows panel rows and badges
- [x] 3.4 Add gutter markers, inline card row and scroll-to-line to `diff/TextDiff.tsx` for unified and split views, and a review mode to `DiffPane.tsx`; verify markers render in both views in the smoke run
- [x] 3.5 Add entry points in the toolbar PR list, GitHub dialogs (PR detail, Create PR footer) and hide them when the provider is disabled; add a progress toast with Cancel; verify by toggling the provider setting
- [x] 3.6 Add review settings and the shortcut to `dialogs/SettingsDialog.tsx`; verify the settings persist across restart

## 4. Verification

- [x] 4.1 Unit tests: `test/review.test.ts` (22 tests) and `gh pr diff` splitting in `test/main-parsers.test.ts`; verify `npm test` passes (54 tests)
- [x] 4.2 `npm run typecheck` clean and `npx electron-vite build` succeeds
- [x] 4.3 Smoke run in branch mode with a stubbed run: pre-flight card, gutter markers, inline card, findings panel and split view screenshots captured
- [ ] 4.4 Live review of a real branch with the Claude Code CLI provider; verify findings anchor to real lines and the dropped count is reported
- [ ] 4.5 Pull request mode against a real GitHub repository including a fork PR; verify `gh pr diff` fallback and contents fetch for context
- [ ] 4.6 Post a review on a test pull request; verify one review with inline comments is created, own-PR restriction applies, and the 422 retry path is exercised with a deliberately bad line
- [ ] 4.7 Update the README Features and AI sections (done) and confirm they still match after live testing
