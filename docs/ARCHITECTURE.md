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
    repo/         repository list, file-system watcher (recursive fs.watch with polling fallback),
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

See [DEVELOPMENT.md](DEVELOPMENT.md) for how to build and test this, and [RELEASING.md](RELEASING.md) for how packaged builds and releases work.
