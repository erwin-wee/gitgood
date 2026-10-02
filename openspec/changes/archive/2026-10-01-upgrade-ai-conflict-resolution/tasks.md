# Tasks

## 1. Block ranges and types

- [x] 1.1 Extend `applyResolutions` in `src/shared/diff/conflicts.ts` to return per-block resolved line ranges; verify with new cases in `test/conflicts.test.ts` covering multi-block, CRLF and empty resolutions
- [x] 1.2 Add `range`, `check`, `guidedBy`, `PostResolveCheckResult`, `ManualResolutionExample` and the new `AiSettings` fields with defaults to `src/shared/types.ts`; verify `npm run typecheck` passes

## 2. Main process

- [x] 2.1 Add `src/main/repo/config.ts` reading `.gitgood/config.json` and the `trustedRepoConfigs` list in `src/main/store.ts`; verify a unit test reads a fixture config and the trust gate refuses untrusted repos
- [x] 2.2 Implement the check runner (shell per platform, cwd repo root, 5-minute timeout, 4,000-char tail) and `ai.resolve.runCheck`; verify with a test using `node -e 'process.exit(2)'` that exit code, timeout and tail are reported
- [x] 2.3 Wire the check into `resolveFile`, blocking auto-stage on failure and attaching `check` to the result; verify a resolver test with a failing command leaves the file unstaged
- [x] 2.4 Implement `ai.resolve.useSideForBlock` re-parsing the original snapshot and refusing on on-disk drift; verify unit test on single-block side replacement and a drift refusal test
- [x] 2.5 Capture manual examples in the `git.conflict.markResolved` handler, add `ai.resolve.examples`, `ai.resolve.clearExamples`, `ai.resolveAllGuided`, and clear examples when the operation ends; verify a test that examples trim to blocks plus context within the 12,000-byte cap and are cleared after abort
- [x] 2.6 Extend `buildResolvePrompt` with `examples` and `checkOutput` and add a debug log line naming the examples used; verify a prompt snapshot test includes the example text

## 3. Renderer

- [x] 3.1 Add the confidence tint layer, gutter badges, legend and next/previous navigation to `TextDiff.tsx` and `DiffPane.tsx`, clearing tints on `repo.changed`; verify by smoke screenshot showing tints and legend counts equal to the toast — implemented in `ConflictDiff.tsx` instead of `TextDiff.tsx`/`DiffPane.tsx` (see report: an AI-resolved-but-unstaged file is still rendered by `ConflictDiff`, not `TextDiff`, until it is staged, so that is where the tint layer needs to live to be visible)
- [x] 3.2 Add `ResolutionPopover.tsx` with rationale, collapsible ours/theirs/base and Accept / Use ours / Use theirs / Use base / Edit in editor actions; verify the smoke script replaces one block and the file shows as modified and unresolved
- [x] 3.3 Update `ConflictsDialog.tsx` with confidence chips, low-first ordering, check status and the Resolve remaining like… dropdown; verify the dropdown appears only after a manual resolution with other files remaining
- [x] 3.4 Add the check-failed banner with Show output and Ask AI to fix (single retry); verify the banner appears with the stubbed failing check and Ask AI to fix triggers exactly one resolver call
- [x] 3.5 Add the check command field, Test command button and repository-command toggle to `SettingsDialog.tsx`, plus the per-repo trust confirmation dialog; verify the confirmation shows the verbatim command and path before the first run

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.2 Smoke pass with `GITGOOD_SMOKE_SCRIPT` on a fixture merge with two conflicted files: resolve one manually, run the guided resolve with the AI stub, capture screenshots of tints and the guided badge; verify the screenshots and store dump match the acceptance scenarios
