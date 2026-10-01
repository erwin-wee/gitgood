# Proposal

## Why

Reviewing a pull request while a feature branch is mid-work means stashing or committing half-finished changes. Git worktrees solve this natively, are increasingly used with coding agents that need separate checkouts, and GitHub Desktop has no support for them at all.

## What Changes

- Add a **Worktrees** dialog (Repository menu, `Ctrl+Shift+W`) listing every worktree of the current repository with path, branch or detached SHA, main/locked/prunable badges and dirty state.
- **Add worktree** for an existing branch, a new branch from a start point, or a detached commit, with a default directory next to the repository.
- **Open**, **Show in Explorer**, **Open in editor**, **Open in terminal**, **Lock/Unlock**, **Remove** (confirmed; second confirmation and force for dirty trees) and **Prune** (confirmed, listing stale entries).
- Worktrees appear nested under their main repository in the repository list; switching between them is a repository switch.
- Checking out a branch that is active in another worktree reports the specific error and offers to open that worktree.
- Ref changes made in one worktree refresh the branch list of the others.

## Capabilities

### New Capabilities

- `worktrees`: listing, creating, opening, locking, removing and pruning git worktrees, and their representation in the repository list.

### Modified Capabilities

_None._

## Impact

- git commands: `git worktree list --porcelain -z` (fallback to line mode), `git worktree add <path> <branch>`, `git worktree add -b <new> <path> <start>`, `git worktree add --detach <path> <sha>`, `git worktree remove [--force] <path>`, `git worktree lock|unlock <path>`, `git worktree prune`, `git rev-parse --git-common-dir`, `git status --porcelain=v2 -z`.
- Code: new `src/main/git/worktree.ts`, `src/main/repo/manager.ts` and `watcher.ts` (nesting, shared common dir), `src/shared/types.ts` (`Worktree`, `RepositoryInfo.worktreeOf`), `src/shared/ipc.ts` (`repo.worktrees`, `git.worktree.add/remove/lock/prune`), error classification in `src/main/exec.ts` for branch-in-use, renderer repository list and dialog, `menu.ts`, new setting `defaultWorktreeDirectory`.
- Removing a worktree deletes its directory and is user-confirmed. No new dependencies.
