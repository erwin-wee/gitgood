# Tasks

## 1. Main process

- [x] 1.1 Add `resolveStashRef(sha)` in `src/main/git/operations.ts` and make `stashPop`/`stashApply`/`stashDrop` resolve a SHA first, throwing a classified `stash-missing` error; verify with a fixture test that drops two stashes in sequence
- [x] 1.2 Add `stashBranch` wrapping `git stash branch` and returning `OperationOutcome`; verify existing-branch and dirty-tree failures surface git's message in a test
- [x] 1.3 Extend `getStashFiles` with `--include-untracked` and the `^3` fallback, and `getStashFileDiff` for untracked files; verify with parser tests in `test/main-parsers.test.ts` covering renames and untracked entries
- [x] 1.4 Add `fileCount` and `untracked` to `Stash` in `src/shared/types.ts`, populate them in `getStashes`; verify typecheck passes and the listing test asserts both fields

## 2. IPC contract

- [x] 2.1 Add `git.stash.branch` and `repo.stash.resolveRef` to `src/shared/ipc.ts` and handlers in `src/main/ipc.ts`; verify typecheck and that the preload bridge exposes them

## 3. Renderer

- [x] 3.1 Add the `'stashes'` view state to the store and actions to load stashes, files and diffs; verify by dumping the store in a smoke run after `actions.setView('stashes')`
- [x] 3.2 Build the Stashes view (list, file list reusing `CommitFileRow`, `DiffPane` with `repo.diff.stash`) with loading, empty and error states; verify with a smoke screenshot
- [x] 3.3 Wire row actions Apply, Pop, Drop (confirmation with message/branch/file count and non-recoverable warning), Create branch from stash dialog, Copy SHA; verify each against the fixture repo
- [x] 3.4 Replace the inline `StashSection` in `ChangesTab.tsx` with a header button and count, add the Repository menu item and `Ctrl+Shift+S` in `menu.ts`, and make the "Stash all changes" toast link to the view; verify the shortcut opens the view
- [x] 3.5 Add "Stash selected files" to the Changes context menu with a dialog for message and include-untracked; verify only the chosen paths are stashed

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Run a smoke pass with a fixture repo containing two stashes (one with untracked files): view lists both, untracked file diff renders, drop of the second after dropping the first removes the right one
