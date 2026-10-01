# Tasks

## 1. Main process

- [x] 1.1 Create `src/main/git/worktree.ts` with `listWorktrees` (porcelain `-z` and newline fallback), `addWorktree`, `removeWorktree`, `lockWorktree`, `pruneWorktrees`; verify with parser tests in `test/main-parsers.test.ts` covering main, detached, locked with and without reason, prunable and bare entries in both formats
- [x] 1.2 Add `worktree-branch-in-use` classification in `src/main/git/git.ts` (`classifyGitError`, not `exec.ts` — classification lives alongside the other git error patterns); verify with a unit test on git's error text
- [x] 1.3 Add `Worktree` and `RepositoryInfo.worktreeOf` to `src/shared/types.ts`, and nest worktrees in `src/main/repo/manager.ts` including removal of worktrees with their main repository; verify with a fixture test that adds a worktree and lists it nested
- [x] 1.4 Extend `src/main/repo/watcher.ts` to watch the worktree's admin directory and the common `refs/`; verify that creating a branch in one worktree emits a refs change for the other

## 2. IPC contract

- [x] 2.1 Add `repo.worktrees`, `git.worktree.add/remove/lock/prune` to `src/shared/ipc.ts` and `src/main/ipc.ts`, plus the `defaultWorktreeDirectory` setting with default; verify typecheck

## 3. Renderer

- [x] 3.1 Build the Worktrees dialog with list, badges, dirty state, loading/empty/error states and row actions; expose `actions.openDialog({ kind: 'worktrees' })`; verify with a smoke screenshot
- [x] 3.2 Build the Add worktree form (existing branch, new branch from start point, detached; directory chooser with default) and branch-in-use handling with "Open that worktree"; verify all three modes against a fixture repo
- [x] 3.3 Implement Remove with the clean/dirty two-step confirmation and force, Lock/Unlock, and Prune with the confirmation list; verify each on the fixture
- [x] 3.4 Nest worktrees in the repository list with per-worktree ahead/behind and a worktree icon, and warn when removing a main repository with worktrees; verify by dumping `repos` after adding a worktree
- [x] 3.5 Add the Repository menu item, `Ctrl+Shift+W` in `menu.ts`, and "Create worktree for this branch…" in the branch context menu; verify the shortcut opens the dialog

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass: add a worktree on a new branch, switch to it, create a commit, switch back and confirm the branch list updated; remove the worktree and confirm the directory is gone
