# Design

## Context

See proposal.md for motivation. Today `getStashes` (operations.ts) returns every stash with `index`, `ref`, `sha`, `message`, `branch`, `date`, `createdByApp`; `getStashFiles`/`getStashFileDiff` (diff.ts) diff a stash against its first parent without `--include-untracked`; `stashPush` already accepts `paths`. The renderer shows stashes inline in `ChangesTab.tsx` via `changes.showingStash`, `stashFiles`, `stashSelectedFile`. `stash@{N}` refs are positional and shift when an entry is dropped.

## Goals / Non-Goals

**Goals:**
- One place to see and act on all stashes, reusing the History three-column layout and `DiffPane`.
- Correctness under concurrent terminal use: never act on the wrong stash.
- Untracked-file stashes are inspectable.

**Non-Goals:**
- Editing stash messages, partial apply of single files from a stash, cross-worktree stash sharing (see `add-worktrees`).

## Decisions

- **Address stashes by SHA, resolve to `stash@{N}` at action time.** `git stash apply|pop|drop` accept only reflog refs (a bare SHA works for apply but not drop). Add `resolveStashRef(sha)` that re-lists with `--format=%gd%x1f%H` and maps SHA to the current ref; every action calls it first and throws a classified `stash-missing` error when absent. Alternative considered: pass the index from the last listing (rejected, races with terminal drops).
- **`Stash` gains `fileCount: number | null` and `untracked: boolean`.** `untracked` is derived from the presence of a third parent (`git rev-parse --verify -q <sha>^3`), computed lazily per row to keep listing cheap; `fileCount` comes from the file listing when the row is selected or from a background pass capped at 50 stashes.
- **Untracked files.** `getStashFiles` adds `--include-untracked` (git ≥ 2.32; fall back to listing `<sha>^3` with `git ls-tree -r --name-only` when the flag is rejected) and merges tracked and untracked entries. Untracked file diffs use `git show <sha>^3:<path>` rendered as an added file.
- **New view instead of a dialog.** A `View` value `'stashes'` with `{ stashes, loading, selectedSha, files, selectedFile }` in the store. The inline `StashSection` in `ChangesTab.tsx` is replaced by a header button with a count badge; the existing "Stash all changes" flow ends with a toast linking to the view. Alternative: keep the inline section (rejected, no room for files + diff).
- **New IPC methods**: `git.stash.branch(repoPath, sha, branchName): Promise<OperationOutcome>` and `repo.stash.resolveRef(repoPath, sha): Promise<string | null>`. Existing `git.stash.pop/apply/drop` keep their `ref` parameter name but accept a SHA; the handler resolves it. `git.stash.push` is reused for "Stash selected files".
- **Commands**: list `git stash list --format=%gd%x1f%H%x1f%gs%x1f%ci`; files `git stash show --name-status -z --include-untracked <ref>`; diff `git diff <ref>^1 <ref> -- <path>`; branch `git stash branch <name> <ref>`; subset `git stash push [-u] -m <msg> -- <paths…>`.

## Risks / Trade-offs

- [Drop is unrecoverable from the app] → confirmation dialog (respecting `confirmDiscardStash`) shows message, branch, file count and says so explicitly.
- [Pop fails with conflicts and git keeps the stash] → reload the list after every action instead of assuming removal.
- [Older git rejects `--include-untracked` on `stash show`] → detect the error text once and fall back to the `^3` tree listing.
- [Large stashes slow the file list] → cap at 2,000 entries with "Show more".
- [Windows paths] → `-z` output is POSIX; convert only when opening in an editor; CRLF handled by the diff parser.
