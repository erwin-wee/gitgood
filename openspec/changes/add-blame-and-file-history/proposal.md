# Proposal

## Why

"Why does this line exist?" is the most common reason users leave GitHub Desktop for the browser or terminal. GitGood already renders files with line numbers and highlighting and already filters history by path, so per-line blame and a rename-following file history close the gap with a parser and a gutter layer.

## What Changes

- Add a **Blame** layer to the diff pane (`Ctrl+Shift+B`): per-run gutter blocks with short SHA, author and age colour, a hover card with commit metadata, *Open commit*, *Copy SHA* and *Blame at parent*.
- Add **File history** mode to the History tab: the commit list is scoped to one file and follows renames; selecting a commit shows that file's diff first.
- From a file history entry: *View file at this commit* (read-only viewer), *Blame at this commit*, *Restore this version…* (confirmed; offers to stash uncommitted changes first).
- Blame and file history are unavailable for binary, image, submodule and too-large files, with an explanatory tooltip.

## Capabilities

### New Capabilities

- `blame`: per-line authorship for a file at the working tree or at a commit, with navigation to the commit and re-blaming at a parent.

### Modified Capabilities

- `history`: the path filter becomes a user-facing file history mode that follows renames and exposes view/blame/restore actions for the file at a commit.

## Impact

- git commands: `git blame --porcelain [-w] -M -C [<rev>] -- <path>`, `git log --format=<FORMAT> --follow --max-count=N --skip=M -- <path>`, `git show <sha>:<path>`, `git log --follow --name-status --format=%H -- <path>`.
- Code: new `src/main/git/blame.ts`, `src/main/git/log.ts` (`--follow` when one path is set), `src/shared/types.ts` (`BlameHunk`, `BlameResult`), `src/shared/ipc.ts` (`repo.blame`, `repo.fileAtCommit`, `repo.pathHistory`, `HistoryOptions.follow`), renderer `TextDiff.tsx` gutter layer, `HistoryTab.tsx` path chip, `ui.tsx` hover card, new setting `blameIgnoreWhitespace`.
- Restore this version writes to the working tree and is a user-confirmed action. No new dependencies.
