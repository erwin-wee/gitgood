# Tasks

## 1. Shared query model

- [x] 1.1 Add `HistoryQuery` and `HistoryOptions.query` in `src/shared/ipc.ts`/`types.ts`; verify typecheck
- [x] 1.2 Implement `parseHistoryQuery` and `formatHistoryQuery` in `src/shared/util.ts`; verify with `test/util.test.ts` cases for every prefix, quoted values, escaped quotes, unknown prefixes as free text and a format→parse round trip

## 2. Main process

- [x] 2.1 Extend the `getHistory` argument builder in `src/main/git/log.ts` for `-S`, `--pickaxe-regex`, `-G`, `--author`, `--after`, `--before`, `--all` and multiple pathspecs; verify with an args-builder test in `test/main-parsers.test.ts` and a fixture repo where `-S needle` returns add and remove commits only while `-G` also returns the change
- [x] 2.2 Add `getMatchingFiles` via `git show --format= --name-only` with the pickaxe flag and expose `repo.history.matchingFiles` in `src/shared/ipc.ts` and `src/main/ipc.ts`; verify with the fixture
- [x] 2.3 Pass the AbortSignal from the renderer request through to the git process so a superseded search is killed; verify by starting a slow query and changing it, asserting the first process exits
  - Implemented as a per-repoPath "latest request wins" `AbortController` map in `src/main/ipc.ts` (the IPC layer has no signal transport from the renderer); `getHistory` takes an optional `signal` and passes it to `git.run`/`git.tryRun`. Verified in `test/fixture/git-log-commit.test.ts` with a pre-aborted `AbortController`, asserting the rejected `GitError`'s `info.code` is `'cancelled'`, per the brief's guidance (not a renderer-observed process exit).

## 3. Renderer

- [x] 3.1 Store `history.query`, `history.matchCount`, `diff.highlightTerm`; debounce query changes 400 ms and cancel the previous request; verify by dumping the store after `actions.setHistorySearch('content:needle')`
  - `history.matchCount` is derived at render time from `history.commits.length`/`hasMore` in `HistoryTab.tsx` rather than stored separately (there is no separate total-count query); functionally equivalent. Cancellation of the previous request is the main-process "latest wins" mechanism from 2.3, not a renderer-held AbortController.
- [x] 3.2 Add the filter popover with two-way sync to the text box and the match count / Clear / timing header in `HistoryTab.tsx`; verify with a smoke screenshot
- [x] 3.3 Narrow the file list to matching files and highlight the first matching line in `TextDiff.tsx`; verify with the fixture repo screenshot
- [x] 3.4 Show inline regex errors before running git and map git regex errors to a friendly message; verify `regex:(` shows the error and no loading spinner
- [x] 3.5 Add `Search History for Selection` in `menu.ts` (accelerator `CmdOrCtrl+Alt+F` — `Ctrl+Shift+F` is already "Show in File Manager") and "Search history for selection" in the diff kebab/context menu; verify the box is pre-filled with `content:` and the selection

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass on a fixture with add/change/remove commits for `needle`: `content:` lists two commits, `regex:` lists three, highlight visible in the screenshot
