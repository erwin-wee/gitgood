# Proposal

## Why

Stashes are second-class in GitGood: only the app-created entries are convenient to work with, and users who also stash from the terminal cannot see what a stash contains, branch from it, or stash a subset of files. GitHub Desktop hides all but one stash per branch; GitGood already lists every stash and can diff stashed files, so the remaining gap is a dedicated view and three small operations.

## What Changes

- Add a dedicated **Stashes** view (Changes tab header button with count, Repository menu, `Ctrl+Shift+S`) with a three-column layout: stash list, file list, diff.
- Stash rows gain file count, an untracked-files indicator, and actions: Apply, Pop, Drop (confirmed), Create branch from stash, Copy SHA.
- Add **Stash selected files** to the Changes tab context menu with an optional message and an *Include untracked* option.
- Stash actions are keyed by SHA and re-resolved to the current `stash@{N}` immediately before running, so dropping one entry never targets the wrong one.
- Stash file listings include untracked files carried by the stash.
- The existing inline stash section in the Changes tab is replaced by navigation to the new view.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `stash`: the stash list moves to a dedicated view with file counts and untracked indicators; inspecting a stash includes untracked files; new actions Pop, Create branch from stash and Stash selected files; discard confirmation states that the stash cannot be recovered from the app; actions are addressed by SHA.

## Impact

- git commands: `git stash list --format=%gd%x1f%H%x1f%gs%x1f%ci`, `git stash show --name-status -z --include-untracked <ref>` (git ≥ 2.32), `git diff <ref>^1 <ref> -- <path>` plus `<ref>^3` for untracked content, `git stash apply|pop|drop <ref>`, `git stash branch <name> <ref>`, `git stash push [-u] -m <msg> -- <paths…>`.
- Code: `src/main/git/operations.ts` (stash wrappers, new branch-from-stash and ref resolution), `src/main/git/diff.ts` (stash file listing with untracked files), `src/shared/types.ts` and `src/shared/ipc.ts` (Stash fields, two new methods), renderer store, `ChangesTab.tsx`, a new Stashes view component, `menu.ts`.
- Settings: reuses `confirmDiscardStash`; no new settings.
- No new dependencies. Independent of `gh` and AI availability.
