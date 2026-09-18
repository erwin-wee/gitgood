# Tasks

## 1. Main process

- [x] 1.1 Create `src/main/git/blame.ts` with `getBlame` running `git blame --porcelain -M -C [-w] [<rev>] -- <path>` and a parser producing `BlameHunk[]`; verify with `test/blame.test.ts` covering multiple hunks, `previous` and `filename` headers, zero-SHA lines and CRLF content
- [x] 1.2 Add `--follow` to `getHistory` when `opts.follow` is set with exactly one path, and add `getPathHistory`; verify with a fixture repo where a file is renamed that both commits are returned and per-commit paths are correct
- [x] 1.3 Add `readFileAtCommit` using `git show <sha>:<path>` with a 2 MB cap and binary detection; verify with a test on a text and a binary fixture
- [x] 1.4 Add `BlameHunk`, `BlameResult`, `HistoryOptions.follow` and the `blameIgnoreWhitespace` setting with default in `src/shared/types.ts` and the store merge; verify typecheck

## 2. IPC contract

- [x] 2.1 Add `repo.blame`, `repo.fileAtCommit`, `repo.pathHistory` to `src/shared/ipc.ts` and handlers in `src/main/ipc.ts`; verify typecheck

## 3. Renderer

- [x] 3.1 Add blame state (`diff.blame`, `diff.blameLoading`, cache keyed by path and rev) and a `toggleBlame` action exposed on `window.__gitgood.actions`; verify by dumping `diff.blame.hunks.length` in a smoke run
- [x] 3.2 Render the blame gutter column in `TextDiff.tsx` with per-hunk grouping, age colour and hunk highlight on select; verify with a smoke screenshot in unified and split view
- [x] 3.3 Build the hover card with Open commit, Copy SHA and Blame at parent, keyboard reachable; verify Open commit selects the commit in History and Blame at parent reblames across a rename
- [x] 3.4 Add file history mode: `history.path` in the store, path chip with clear in `HistoryTab.tsx`, file's diff shown first on selection; verify with the rename fixture
- [x] 3.5 Add entry points (diff header menu, Changes and History file context menus, `Alt+B` in `menu.ts` — `Ctrl+Shift+B` was already bound to "Compare to Branch") and disable them for binary, image, submodule and too-large diffs with a tooltip; verify manually against fixtures of each kind
- [x] 3.6 Add "View file at this commit" read-only viewer and "Restore this version" with confirmation and the stash-first offer; verify restore overwrites the file and it appears in Changes

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass: open the fixture repo, toggle blame on a file, screenshot the gutter, open file history for the renamed file and confirm both commits are listed
