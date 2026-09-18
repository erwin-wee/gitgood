# Proposal

## Why

Every repository has to be added one at a time through "Add local repository", even though people keep all of their clones under one or two folders (`~/Projects`, `~/Projects/<org>/<repo>`). After a fresh install, a new machine or a `git clone` run from the terminal, the repository list is out of step with the disk until the user goes and re-adds each clone by hand.

## What Changes

- Add **watched folders**: a list of folders in Options → Git, each with its own scan depth (default 3, range 1–10). Every Git repository found under a watched folder is added to the repository list automatically.
- Scanning is filesystem-only and bounded: a directory containing `.git` is a repository and is not descended into; `node_modules`, `vendor`, `target`, `dist`, `build`, `.cache` and dot-directories are skipped; symlinked directories are not followed.
- Scans run **on app launch**, **when the watched-folder list or a folder's depth changes**, and on an explicit **Rescan now**. There is no background filesystem watch of the folders, so a repository cloned outside GitGood appears after the next launch or rescan.
- Discovered repositories are marked as such in the repository list (a "from watched folder" origin) and are otherwise ordinary entries: they can be opened, aliased and removed like any other.
- **Removing a repository that lives under a watched folder records an exclusion**: its path is persisted and later scans never re-add it, whether it was discovered by a scan or added by hand — otherwise removing a hand-added repository inside a watched folder would not stick, because the next scan would find it again. Repositories outside every watched folder are removed as they are today, with no exclusion. Options lists the excluded paths with "Remove from list" (un-exclude) and "Clear all".
- A repository already in the list is never added twice, even when the list holds it under a symlinked path and the scan reaches it by its real path; linked worktrees stay separate entries from their main repository.
- A discovered repository whose folder no longer exists on disk is dropped from the list on the next scan, rather than left as a "missing" entry. Manually added repositories keep today's missing behaviour.
- Scan results are reported: a toast/summary with how many repositories were added and a count of folders that could not be read (permissions), and a per-folder "not found / not a directory" warning in Options.
- The scan is cancellable and reports progress while running, and never blocks the window: it runs after the first paint on launch.

## Capabilities

### New Capabilities

- `watched-folders`: registering folders to scan, the bounded recursive discovery of Git repositories under them, when scans run, how discovered repositories enter and leave the repository list, and the exclusion list.

### Modified Capabilities

_None._ No existing spec's requirements change: discovered repositories are ordinary `RepositoryInfo` entries, and watched folders are machine-local paths that are deliberately left out of the settings export (see design).

## Impact

- git commands: no new ones. Discovery is `node:fs` only (`readdir` with `withFileTypes`, `lstat`); each candidate is confirmed through the existing `RepositoryManager.add`, which already runs `git rev-parse --show-toplevel` (`getTopLevel`) and `git remote -v` (`getRemotes`, for the GitHub association). Worktree nesting continues to use `git rev-parse --git-common-dir` / `git worktree list` as it does today.
- Code: new `src/main/repo/scan.ts` (pure, testable walker) and `src/main/repo/watched-folders.ts` (scan orchestration, exclusions); `src/main/repo/manager.ts` (bulk add, `origin` on `RepositoryInfo`, dropping vanished discovered repositories); `src/main/store.ts` (`watchedFolders` setting, persisted `excludedRepositoryPaths`); `src/shared/types.ts` (`WatchedFolder`, `RepositoryInfo.origin`, `RepositoryScanResult`); `src/shared/ipc.ts` + `src/main/ipc.ts` (`repos.scanWatchedFolders`, `repos.exclusions.list/clear/remove`, progress event); `src/main/index.ts` (launch scan); renderer Options → Git section, repository-removal dialog copy, repository list badge; `docs/` and the README Features list.
- No new runtime dependencies. Removal of a repository stays user-confirmed and never deletes the folder unless the existing "move to Trash" option is used; the scan itself only reads directory entries and writes nothing to disk outside GitGood's own state.
