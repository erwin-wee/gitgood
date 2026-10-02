# Design

## Context

See proposal.md. `getHistory` (log.ts) builds `git log --format=<FORMAT> --max-count --skip` and, for a search term, runs separate `--grep` and `--author` queries and a SHA lookup, merging results; it accepts a single `opts.path`. History rows are draggable only when no search is active. `exec.ts` already supports cancellation via AbortSignal.

## Goals / Non-Goals

**Goals:** expose git's pickaxe and log filters through one query model shared by the text box and popover; keep free-text behaviour unchanged; never leave the UI stuck on a slow query.

**Non-Goals:** `git grep` over file contents at a ref, saved searches, line-range history.

## Decisions

- **Structured query alongside legacy text.** `HistoryOptions` gains `query?: HistoryQuery { content, contentRegex, diffRegex, paths, author, after, before, allRefs }` while `search` keeps carrying free text. A pure `parseHistoryQuery(text)` in `src/shared/util.ts` splits prefixes (supporting `"quoted values"` and `\"` escapes, unknown prefixes treated as free text) and `formatHistoryQuery(query)` round-trips for the popover. Alternative: separate UI-only state per filter (rejected, would not round-trip).
- **Argument builder.** `content` → `-S<text>` (+`--pickaxe-regex` when `contentRegex`), `diffRegex` → `-G<expr>`, `author` → `--author=`, dates → `--after=`/`--before=`, `allRefs` → `--all`, `paths` → `-- <pathspec…>` with `:(glob)` magic when a glob is present. Free text keeps the current grep/author/SHA merge. Never pass `--text`, so binary files do not match.
- **Matching files and highlight.** New `repo.history.matchingFiles(repoPath, sha, query)` runs `git show --format= --name-only -S<text>|-G<expr> <sha>`; the renderer stores `diff.highlightTerm { text, regex }` and `TextDiff.tsx` marks the first matching parsed line, so CRLF cannot affect matching.
- **Cancellation and debounce.** Query changes debounce 400 ms and abort the previous exec via its AbortSignal. Pickaxe pages use `--max-count=200`.
- **Validation.** Client-side check only for balanced brackets and parentheses; other regex errors come from git's stderr mapped to a friendly message. Git regexes are POSIX ERE.
- **UI.** Filter icon beside the existing `FilterInput` opens a popover (content with regex toggle, path, author, after/before date pickers, All branches checkbox). Header shows "N commits match", Clear chip, and "Search took X s". `Ctrl+Shift+F` and a diff context-menu item pre-fill `content:` from the selection. Dragging stays disabled while any filter is active.

## Risks / Trade-offs

- [Pickaxe over large histories takes minutes] → cancellable exec, debounce, 5-second hint to add `path:`, paging at 200.
- [POSIX ERE surprises users used to JavaScript regexes] → inline help text in the popover; git's own error is surfaced.
- [`--all` in repositories with many remotes adds noise] → ref badges on rows make provenance visible.
- [Windows quoting] → exec runs without a shell so arguments pass verbatim; pathspecs stay POSIX.
