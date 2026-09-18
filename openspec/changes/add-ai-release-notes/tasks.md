# Tasks

## 1. Range gathering

- [x] 1.1 Add `ReleaseRange`, `ReleaseCommit`, `ReleasePr`, `ReleaseNotesInput`, `ReleaseNotes`, `CreateReleaseOptions`, the new IPC methods and `AiSettings.releaseNotesAudience` to `src/shared/types.ts` and `src/shared/ipc.ts`; verify `npm run typecheck`
- [x] 1.2 Implement the latest-tag helper, non-merge log parsing with the 500 cap, PR number extraction from merge and squash subjects, and the diff stat; verify `test/release-notes.test.ts` covers PR extraction and a temp-repo test with two tags returns the right range
- [x] 1.3 Implement `repo.release.range` including `gh pr view` lookups (cap 100, concurrency 4) when PRs are included; verify a stubbed `gh` returns titles merged into the preview

## 2. Generation and validation

- [x] 2.1 Add the schema and prompt builder to `src/main/ai/prompts.ts` with the 400-char body trim and `truncated` flag; verify a prompt test
- [x] 2.2 Implement `ai.releaseNotes` with reference validation, unreferenced computation, fixed section order, duplicate merge, caps and Markdown assembly; verify unit tests for invalid refs, zero-ref items, omission listing and Markdown format
- [x] 2.3 Implement `repo.changelog.insert` inserting under the top heading or creating the file, preserving EOL; verify tests with and without an existing heading and with CRLF
- [x] 2.4 Implement `GhClient.releaseView` and `releaseCreate` and the two IPC methods; verify a stubbed `gh` test passes `--draft` by default and `--target` when the tag is missing

## 3. Renderer

- [x] 3.1 Add `ReleaseNotesDialog.tsx` with inputs, preview list, semver next-patch suggestion, Generate (hidden when provider disabled), Export commit list, progress and cancel; add the Repository menu item and the tag context item; verify the dialog opens from both entry points
- [x] 3.2 Add the Markdown editor with preview toggle, Copy Markdown, the unreferenced list with Add, Insert into CHANGELOG.md that then selects the file in Changes, and the Create GitHub release confirmation (draft default, existing-release detection, not-signed-in state); verify the smoke script inserts notes and the status shows `CHANGELOG.md` modified
- [x] 3.3 Add the audience setting to `SettingsDialog.tsx` and expose `openReleaseNotes` on `window.__gitgood.actions`; verify the default audience is users

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.2 Smoke pass on a fixture repo with tag `v0.1.0`: open the dialog, generate with the AI stub, screenshot the editor, insert into the changelog; verify the store dump shows the modified file
