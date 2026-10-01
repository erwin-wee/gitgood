# Proposal

## Why

Slow clones caused by accidentally committed binaries, hundreds of merged branches and forgotten local commits are invisible in GitHub Desktop and in GitGood. The app already computes ahead/behind per repository and lists branches with dates, so a health view mostly aggregates existing data plus two object-store queries.

## What Changes

- Add a **Repository health** view (Repository menu, `Ctrl+Shift+H`) with four independently loading cards: Large files, Stale branches, Unpushed work across all repositories, and Housekeeping.
- Large files: the 25 largest blobs in history with path, size, first commit, presence at HEAD and whether LFS would have applied; actions to copy the path, add a `.gitignore` pattern or jump to LFS tracking.
- Stale branches: merged, inactive (configurable days) and upstream-gone branches with multi-select bulk delete (optionally remote), undo for local deletions, and remote-tracking prune. The current, default and known protected branches are never deletable.
- Unpushed work: per repository, branches ahead of upstream, unpublished branches, stash count and uncommitted change count; click opens the repository on that branch. A compact card on the Welcome screen and an opt-in warning dot on repository rows surface the same data.
- Housekeeping: `.git` size, loose objects, packs, last gc; confirmed actions to run gc, prune remotes and expire the reflog.

## Capabilities

### New Capabilities

- `repo-health`: read-only diagnostics of repository size, branch hygiene and unpushed work, with explicitly confirmed remediation actions.

### Modified Capabilities

_None._

## Impact

- git commands: `git rev-list --objects --all` piped into `git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'`, `git ls-tree -r HEAD --name-only`, `git log --diff-filter=A --format=%H%x1f%aI -1 -- <path>`, `git branch --merged <default>`, `git for-each-ref --format=%(refname:short)%x1f%(committerdate:iso-strict)%x1f%(upstream:short)%x1f%(upstream:track)`, `git branch -D`, `git push <remote> --delete`, `git remote prune`, `git count-objects -v`, `git gc`, `git reflog expire --expire=now --all`.
- Code: new `src/main/git/health.ts`, `src/main/git/branches.ts` (age and gone info), `src/main/repo/manager.ts` (indicator gains unpublished branch and stash counts, cross-repo work scan), `src/shared/types.ts` (`LargeBlob`, `StaleBranch`, `RepoWork`, `Housekeeping`), `src/shared/ipc.ts` (`repo.health.*`, `repos.work`, `git.branch.deleteMany`, `git.remote.prune`, `git.gc`, `git.reflog.expire`), renderer view and Welcome card, `menu.ts`, settings `staleBranchDays` and `healthLargeFileThresholdBytes`.
- Bulk branch deletion, gc and reflog expiry are destructive and user-confirmed. No `gh` needed; LFS suggestions hidden when LFS is absent. No new dependencies.
