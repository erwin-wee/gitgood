# Proposal

## Why

Empty directories after cloning a repository with submodules, and 130-byte pointer files where an asset should be, are two of the most common "git is broken" reports from GitHub Desktop users. GitGood currently shows both only as placeholders in the diff pane.

## What Changes

- Add a **Submodules** dialog listing each submodule with its state (up to date, not initialized, modified, differs from recorded, conflicted), with initialize/update, sync URLs, open as repository and show in file manager actions; a banner after clone offers to initialize uninitialized submodules.
- Enrich the diff pane's submodule summary with *Update to recorded commit* and *Open submodule*.
- Detect Git LFS usage and installation; show an install banner when a repository uses LFS but LFS is missing.
- Label LFS pointer files in file lists, show an LFS summary in the diff pane (with image diff when both objects are local images), and offer to download missing objects.
- Add a **Git LFS** dialog: status, tracked patterns, install hooks, track/untrack patterns, fetch all, pull, prune with dry-run confirmation.

## Capabilities

### New Capabilities
- `submodules`: viewing submodule state and initializing, updating, syncing and opening submodules.
- `lfs`: detecting Git LFS usage and installation, labelling pointer files, and managing LFS objects and tracked patterns.

### Modified Capabilities
- (none; existing diff kinds and file lists gain additional information but their current behaviour is unchanged.)

## Impact

- `git` commands: `git submodule status --recursive`, `git config --file .gitmodules --list -z`, `git submodule update --init --recursive --progress [-- <path>]`, `git submodule sync --recursive`, `git ls-tree HEAD <path>`, `git -C <path> rev-parse HEAD`; `git lfs version`, `git lfs ls-files -l -s`, `git lfs status --porcelain`, `git lfs install --local`, `git lfs track|untrack`, `git lfs fetch --all`, `git lfs pull [--include <path>]`, `git lfs prune [--dry-run]`.
- Code: new `src/main/git/submodules.ts` and `src/main/git/lfs.ts`, `src/main/git/diff.ts` (pointer detection before binary detection, new diff kind), `src/main/git/status.ts` (LFS flag), `src/main/tools.ts` (locate git-lfs), `src/shared/types.ts` / `src/shared/ipc.ts`, renderer dialogs, banners, file list chips and diff summaries, Repository menu.
- `git lfs prune` deletes local objects and is gated on a dry-run confirmation; all long transfers report progress and are cancellable.
