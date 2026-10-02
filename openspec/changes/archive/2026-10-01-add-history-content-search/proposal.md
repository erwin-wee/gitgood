# Proposal

## Why

"When did this function disappear?" cannot be answered in GitHub Desktop or in GitGood today: history search only matches message, author and SHA. Git's pickaxe (`-S`, `-G`) plus path, author and date filters answer it directly, and the History tab already has the search box and paging to host them.

## What Changes

- Extend the History search box with a small query syntax: `content:` (added/removed string), `regex:` (diff regex), `path:`, `author:`, `after:`, `before:` and `all:` (search every ref). Plain text keeps today's behaviour.
- Add a filter popover with the same fields as form controls that round-trips to and from the text syntax.
- Results show a match count, a Clear chip and, when `all:` is on, the refs containing each commit.
- For content and regex searches the selected commit's file list is narrowed to matching files and the diff pane highlights the first matching line.
- In-flight searches are cancellable and are cancelled when the query changes; invalid regexes are reported inline before git runs.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `history`: the searchable commit list requirement gains content, regex, path, author, date and all-refs filters, cancellation and inline query errors; commit details gain match-narrowed files and match highlighting.

## Impact

- git commands: `git log <FORMAT> -S<text> [--pickaxe-regex]`, `-G<regex>`, `--author=<re>`, `--after=`, `--before=`, `--all`, pathspecs with `:(glob)` magic, `git show --format= --name-only -S<text> <sha>`.
- Code: `src/main/git/log.ts` (`getHistory` argument builder, `getMatchingFiles`), `src/shared/ipc.ts` (`HistoryOptions.query`, `repo.history.matchingFiles`), `src/shared/util.ts` (`parseHistoryQuery`/`formatHistoryQuery`), renderer `HistoryTab.tsx` popover and count, `TextDiff.tsx` term highlight, `menu.ts` (`Ctrl+Shift+F`).
- Performance: pickaxe on large repositories can take minutes; requires the cancellable exec path. No new dependencies.
