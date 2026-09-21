# Architecture

```
src/
  main/           Electron main process
    exec.ts       child-process runner (no shell, cancellable, progress streaming)
    tools.ts      locate git / gh / claude, read gh auth status, login-shell PATH on macOS/Linux
    git/          git wrappers: status (porcelain v2), log (history, file history via --follow),
                  branches, diffs, blame (porcelain parser, file-at-commit), commits,
                  transfers with progress, merge/rebase/cherry-pick/revert, interactive-rebase
                  automation (squash/reorder/reword/drop) via a GIT_SEQUENCE_EDITOR shim, stash, tags,
                  worktrees (list/add/remove/lock/prune, main-worktree resolution)
    gh/           GitHub CLI wrapper: device-flow login, repos, pull requests, checks, avatars
    ai/           Anthropic SDK + Claude CLI backends, prompts, conflict resolver,
                  pull request AND pre-commit review service (review.ts, worktree target) and its
                  pure validation helpers (review-core.ts, shared by both),
                  diff explanation service (explain.ts) and its pure validation helpers (explain-core.ts)
                  agent handoff export (review-export.ts: JSON + Markdown written to <git-dir>/gitgood/review
                  after every run, read by terminal coding agents; see plugin/)
    update/       auto-update: UpdateProvider seam, electron-updater-backed provider, pure
                  semver/channel/reducer/gate logic (update-core.ts), orchestration (updater.ts)
    repo/         repository list, Git-pruned directory watcher in a worker thread,
                  watched folders: a pure bounded directory walker (scan.ts) plus the scan
                  orchestration, exclusions and folder validation (watched-folders.ts); path
                  comparison with the platform's case rules lives in paths.ts
    integrations/ external editors and terminals per platform (shell-command.ts: running a command in a
                  new terminal window for "Fix with agent")
    protocol.ts   gitgood:// and x-github-client:// URL parsing (openRepo, review/rerun deep link)
    ipc.ts        typed request handlers for every API method
  preload/        contextBridge exposing a single typed invoke/on bridge
  renderer/       React UI (no UI framework dependencies)
  shared/         types, IPC contract, pure diff logic (unified diff parser, partial-patch
                  builder, intraline word diff, conflict marker parser)
```

Renderer and main process communicate over one typed channel (`src/shared/ipc.ts`). All git commands run with `GIT_TERMINAL_PROMPT=0`, so nothing ever blocks on a hidden prompt; errors are classified (auth, network, non-fast-forward, conflicts, protected branch, …) to drive the right dialog.

Repository watching runs in `repo/watcher-worker.ts`; `watcher.ts` only owns the worker and forwards coalesced change notifications. Git enumerates cached and non-ignored files, preserving tracked files inside ignored directories and honoring nested, negated, global and repository-local ignore rules. Only their containing directories and relevant Git metadata directories receive non-recursive `fs.watch` subscriptions; ignored output trees and Git object storage are not recursively scanned. Git commands, file metadata comparisons, directory subscription updates and polling all stay off the Electron main thread.

Native events trigger bounded 120 ms reconciliation. A four-second reconciliation also detects missed events, changes to external ignore rules and files added inside previously empty directories; submodule dirty status is refreshed on reconciliation. If native watching fails, the same worker continues polling. File metadata includes nanosecond modification/change times, so editing an already-modified file still refreshes its diff. Switching repositories stops the old worker and suppresses late notifications; shutdown aborts its Git child. electron-vite's `?nodeWorker` import bundles the worker alongside the main entry, including in ASAR packages.

History, changes, and text diffs window their rendered rows. `TextDiff` computes word-level changes only when either row of a paired deletion/addition renders, caches both sides, and invalidates them when the hunks or word-highlighting setting change. Syntax highlighting remains lazy per 400-line block.

See [DEVELOPMENT.md](DEVELOPMENT.md) for how to build and test this, and [RELEASING.md](RELEASING.md) for how packaged builds and releases work.
