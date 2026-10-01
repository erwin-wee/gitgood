# Design

## Context

See proposal.md. `RepositoryInfo` is flat; `RepositoryWatcher` watches a repository's `.git` directory recursively with a polling fallback; a worktree's `.git` is a file pointing at `<common>/worktrees/<name>`. `getStatus` uses porcelain v2. Editors and shells are launched by path through `src/main/integrations`. The project requires git ≥ 2.30; `worktree list --porcelain -z` needs 2.36.

## Goals / Non-Goals

**Goals:** worktrees as ordinary repositories in the list so every view works unchanged; safe removal; watcher correctness for shared refs.

**Non-Goals:** `git worktree move`, automatic worktree creation on PR checkout, sharing stashes or the Changes view across worktrees, submodule updates inside worktrees.

## Decisions

- **Model.** `Worktree { path, head, branch | null, isMain, isCurrent, locked: string | null, prunable: string | null, dirty: boolean | null }`. `RepositoryInfo.worktreeOf: string | null` points at the main repository id; the list nests on it. Alternative: a separate worktree list outside the repository list (rejected, would need parallel view plumbing).
- **Wrapper.** New `src/main/git/worktree.ts`: `listWorktrees` parses `--porcelain -z`, falling back to newline mode when the flag is rejected; `addWorktree` handles the three modes (`<path> <branch>`, `-b <new> <path> <start>`, `--detach <path> <sha>`); `removeWorktree(path, force)`, `lockWorktree(path, locked, reason)`, `pruneWorktrees`. The main repository of a worktree is found by comparing `git rev-parse --git-common-dir` with `--git-dir`. Dirty state runs `getStatus` per worktree lazily (only when the dialog is open).
- **IPC.** `repo.worktrees(repoPath)`, `git.worktree.add(repoPath, { path, branch, newBranch, startPoint, detach }) → RepositoryInfo`, `git.worktree.remove(repoPath, worktreePath, force)`, `git.worktree.lock(repoPath, worktreePath, locked, reason)`, `git.worktree.prune(repoPath)`. Setting `defaultWorktreeDirectory` (empty means sibling of the repository).
- **Error classification.** Add `worktree-branch-in-use` in `exec.ts` matching git's "is already checked out at" / "is already used by worktree" text; the checkout dialog and add dialog map it to "Open that worktree" using the path in the message.
- **Watcher.** For a worktree, watch `<common>/worktrees/<name>` (HEAD, index) plus the common `refs/` and `packed-refs`; the main repository's watcher already covers `refs/`. Ref changes fan out to every repository sharing the common dir.
- **Paths.** Porcelain output uses forward slashes on Windows; normalise with `path.normalize` for display and comparison, pass POSIX to git. Long-path failures surface git's error.

## Risks / Trade-offs

- [Removing deletes the directory outright] → confirmation states no Recycle Bin; dirty trees need a second confirmation and only then `--force`.
- [Old git lacks `-z` for list] → parse newline mode as a fallback, tested with both fixtures.
- [Watcher misses shared ref changes] → watch the common `refs/` from every worktree and rely on the polling fallback.
- [Listing dirty state for many worktrees is slow] → compute lazily while the dialog is open, with `dirty: null` until known.
