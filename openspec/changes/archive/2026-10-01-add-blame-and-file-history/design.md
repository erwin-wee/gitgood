# Design

## Context

See proposal.md. `getHistory` (log.ts) already accepts `opts.path` and passes `-- <path>` but not `--follow`. `TextDiff.tsx` renders lines with old/new numbers and a syntax layer; `CommitFile` rows exist in History. `repo.readFile` reads working-tree content only. `UncommittedChangesStrategy` already models stash-or-carry choices.

## Goals / Non-Goals

**Goals:** blame as a decoration layer on the existing text renderer; file history as a mode of the existing History tab; all reads bounded in size.

**Non-Goals:** blame inside the conflict view, line-range history (`git log -L`), avatars in the gutter.

## Decisions

- **`git blame --porcelain` (non-incremental), parsed in `src/main/git/blame.ts`.** Porcelain gives per-line commit headers once per commit plus `previous` and `filename` headers, enough for "Blame at parent" and rename-aware re-blame. Incremental mode was considered for streaming but complicates ordering for little gain under the 20,000-line cap. `-w` is added when `blameIgnoreWhitespace` (new setting, default true) is on; `-M -C` always.
- **Types.** `BlameHunk { sha, shortSha, author: Identity, summary, originalPath, startLine, lineCount, previousSha }`, `BlameResult { path, rev, hunks, content, language }`. Uncommitted lines carry the all-zero SHA.
- **IPC.** `repo.blame(repoPath, path, rev | null, ignoreWhitespace)`, `repo.fileAtCommit(repoPath, sha, path) → { content, binary, bytes }` via `git show <sha>:<path>` capped at 2 MB, `repo.pathHistory(repoPath, path) → { sha, path }[]` via `git log --follow --name-status --format=%H -- <path>` to know the file's name per commit. `HistoryOptions` gains `follow: boolean`, defaulting to true when exactly one path is set; `getHistory` adds `--follow` in that case.
- **Renderer.** Blame is a left gutter column (fixed 22ch) inside `TextDiff.tsx` grouped per hunk with an age heat colour computed relative to the oldest and newest commit in the file. Results are cached per `(path, rev)` until a `repo.changed` event touches the path. The hover card is a portal component styled like the commit tooltip in `ui.tsx`, focusable via the gutter (Enter opens). History gets `history.path` in the store and a path chip in the header. The read-only viewer is `DiffPane` in a `file` mode.
- **Restore.** Confirms, checks status for the path; if modified, offers the stash choice through the existing strategy dialog, then writes via `repo.writeFile`.

## Risks / Trade-offs

- [Blame cost is linear in file size and history depth] → 20,000-line cap, cancellable exec, renderer cache.
- [Rename tracking differs between `--follow` and blame `filename` headers] → always re-blame with `originalPath` from the hunk, never the current path.
- [Shallow clones stop attribution at the boundary] → detect `.git/shallow` and show the truncation notice.
- [CRLF line counting] → count lines from parsed content so gutter rows align with `TextDiff` numbering.
- [Windows paths] → paths passed after `--` without quoting; exec runs without a shell.
