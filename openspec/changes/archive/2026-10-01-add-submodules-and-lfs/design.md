# Design

## Context

See proposal.md. `WorkingFile.submodule` and the `submodule` `FileDiff` kind exist. `TransferProgressParser` parses fetch progress. `findExecutable` in `tools.ts` locates tools. Image diffs exist for regular image files. `exec.ts` supports cancellation.

## Goals / Non-Goals

**Goals:**
- Make submodule and LFS state visible where the user already looks (Changes, History, diff pane) and add one dialog per feature.
- Reuse progress and cancellation plumbing for updates, fetches and pulls.

**Non-Goals:**
- Adding or removing submodules from the UI; LFS file locking (status only mentions locks); `git lfs migrate`.

## Decisions

- **Two capabilities, one change.** Submodules and LFS are independent behaviours; splitting the specs keeps each archivable on its own while sharing the dialog shell work.
- **Pointer detection before binary detection.** In `diff.ts`, check for `version https://git-lfs.github.com/spec/v1` (accept trailing `\r`) before `looksBinary`, and emit a new `FileDiff` kind `lfs` with an optional `inner` image diff.
- **Submodule state** from `git submodule status --recursive` prefixes (`-` uninit, `+` differs, `U` conflict) combined with `git config --file .gitmodules --list -z` for URLs and `git ls-tree HEAD <path>` vs `git -C <path> rev-parse HEAD`.
- **Open as repository** creates an independent `RepositoryInfo` with a new optional `parentRepoId` so the list can nest it; no worktree-style linkage.
- **LFS tool discovery** via `git lfs version` exit code (falls back to `findExecutable('git-lfs')`), exposed as `ToolsState.gitLfs`.
- **Prune safety**: run `git lfs prune --dry-run` first and confirm with its numbers.

Commands: see proposal Impact. Progress: `--progress` on submodule update parsed by `TransferProgressParser`; LFS stderr progress parsed line-by-line and emitted on the existing `progress` event with kind `'generic'`.

Types and IPC:

```ts
interface Submodule { path; name; url; recordedSha; checkedOutSha: string | null; state: 'up-to-date' | 'uninitialized' | 'differs' | 'conflicted' | 'missing'; nested: boolean }
interface LfsStatus { installed; version: string | null; hooksInstalled; usedByRepo; patterns: string[]; trackedFiles; localBytes: number | null; missingFiles }
interface LfsFile { path; oid; size; present }
FileDiff |= { kind: 'lfs'; path; oldOid; newOid; size; present; inner: FileDiff | null }
CommitFile.lfs, WorkingFile.lfs: boolean; RepositoryInfo.parentRepoId?: string; ToolsState.gitLfs: ToolInfo

'repo.submodules': (repoPath) => Promise<Submodule[]>
'git.submodule.update': (repoPath, paths: string[] | null, init: boolean) => Promise<void>
'git.submodule.sync': (repoPath) => Promise<void>
'repo.lfs.status': (repoPath) => Promise<LfsStatus>
'repo.lfs.files': (repoPath) => Promise<LfsFile[]>
'git.lfs.install': (repoPath) => Promise<void>
'git.lfs.track': (repoPath, pattern, track: boolean) => Promise<void>
'git.lfs.fetch': (repoPath, mode: 'fetch-all' | 'pull', paths: string[] | null) => Promise<void>
'git.lfs.prune': (repoPath, dryRun: boolean) => Promise<{ objects; bytes }>
```

UI: Repository menu items *Submodules…* and *Git LFS…*; post-clone banner; LFS install banner; Submodules table with row actions; LFS dialog with status card, pattern list and actions; Options → Advanced shows the LFS tool row next to git and gh.

## Risks / Trade-offs

- [Deep recursive submodules] → cap displayed depth at 3 with a nested badge.
- [Prune deletes local data] → dry-run first, confirmation with numbers.
- [Missing LFS hooks silently push pointers] → loud warning in status card.
- [CRLF in `.gitattributes`] → detect existing line endings before appending when the app edits the file itself; pointer detection tolerates `\r`.
- [Large LFS pulls block] → progress and cancellation via `exec.ts`.
