# Design

## Context

See proposal.md. `repos.refreshIndicators` in `manager.ts` already computes ahead/behind per repository; `getBranches` returns dates and upstream info; `deleteLocalBranch`/`deleteRemoteBranch` exist; `exec.ts` runs single processes without a shell and buffers output.

## Goals / Non-Goals

**Goals:** bounded-memory scans of large object stores; reuse of existing branch data; every destructive action confirmed with a recovery story.

**Non-Goals:** rewriting history to remove files (link to documentation), server-side size via `gh api`, scheduled scans.

## Decisions

- **Large blobs via two piped processes in Node.** `git rev-list --objects --all` streams into `git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'` connected with Node streams (no shell, no `maxBuffer`); lines are parsed splitting on the first three spaces so paths with spaces survive; a bounded top-25 heap keeps memory flat. Presence at HEAD is a set from `git ls-tree -r HEAD --name-only`; first commit is looked up only for the 25 shown. Alternative: `git rev-list --objects --all | sort` in a shell (rejected, shell and memory).
- **Stale branches reuse `getBranches`.** Extend `branches.ts` to expose committer date and `[gone]` from `for-each-ref`; merged status from `git branch --merged <default>`; inactivity threshold from setting `staleBranchDays` (default 90). Protected names come from `gh repo view` when available.
- **Bulk delete with undo.** `git.branch.deleteMany(repoPath, names, deleteRemote) → { deleted, failed }` records each tip SHA before `git branch -D`; the toast's Undo runs `git branch <name> <sha>` for local deletions. Remote deletion uses `git push <remote> --delete <name>` per branch.
- **Cross-repo work.** `repos.work()` extends the cached indicator with `unpublishedBranches` and `stashes`, scanning repositories with concurrency 3 and skipping `missing` ones, using `for-each-ref` with `%(upstream:track)`, `getStashes` and a cheap `getStatus`.
- **Housekeeping.** `git count-objects -v` parsed into `Housekeeping`; `.git` size via a Node directory walk; `git gc [--aggressive]`, `git remote prune <remote>`, `git reflog expire --expire=now --all`. All are blocked while `RepositoryStatus` reports an operation in progress.
- **Types and IPC.** `LargeBlob`, `StaleBranch`, `RepoWork`, `Housekeeping`; methods `repo.health.largeFiles(repoPath, limit)`, `repo.health.staleBranches(repoPath, inactiveDays)`, `repo.health.housekeeping(repoPath)`, `repos.work()`, `git.branch.deleteMany`, `git.remote.prune`, `git.gc`, `git.reflog.expire`. Settings `staleBranchDays`, `healthLargeFileThresholdBytes` (default 5 MB, drives the Welcome warning).
- **UI.** Two-by-two card grid, per-card progress bar and cancel; bulk delete dialog with reasons, tip SHAs and the remote checkbox; Welcome card listing repositories with warnings; opt-in row dot.

## Risks / Trade-offs

- [Millions of objects] → streaming pipe, bounded heap, cancellable.
- [Deleting branches loses commits] → `-D` only after confirmation showing tip SHAs; Undo recreates from recorded SHAs; reflog keeps them until expiry.
- [reflog expire and gc prune are irreversible] → two-step confirmation with explanation; disabled during operations.
- [Non-UTF-8 paths in `--objects` output] → displayed as-is, never re-encoded.
- [Windows piping] → Node stream piping between child processes, no shell.
