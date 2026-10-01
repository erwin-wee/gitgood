# Architecture

```
src/
  main/           Electron main process
    index.ts      app lifecycle, windows, menu, protocol and argv handling, client/server mode selection
    exec.ts       child-process runner (no shell, cancellable, progress streaming)
    tools.ts      locate git / gh / claude, read gh auth status, login-shell PATH on macOS/Linux;
                  each probe settles on its own (git never waits for gh or claude) and flags tools
                  older than the minimum version
    logger.ts     application log (0600), every line passed through shared/secrets.ts scrubSecrets
    store.ts      JSON persistence (settings, repositories, secrets): 0600 files in a 0700 directory,
                  a corrupt file is renamed to <file>.corrupt-<ts> instead of being reset
    app-url.ts    the app's entry URL and the IPC/navigation allowlist: only the main frame loaded from
                  that URL may call IPC (ipc.ts, client.ts) or be navigated to (window.ts)
    argv.ts       pure `gitgood <path>` parsing (skips flags, the dev app path, protocol URLs)
    core/         transport-independent request layer shared by Electron and the server
                  (handlers.ts: every API method; host.ts: native capabilities behind an interface;
                  bus.ts: event emitter; client-context.ts: the calling client and per-client job
                  ownership; event-routing.ts: which window receives which event)
    host/         Electron implementations of the host and store-platform interfaces
    git/          git wrappers: status (porcelain v2, plus a light ahead/behind/dirty parse for repository
                  indicators), log (history, file history via --follow, --date-order for the graph),
                  branches (incl. stack detection), diffs, blame (porcelain parser, file-at-commit), commits,
                  transfers with progress, merge/rebase (--update-refs)/cherry-pick/revert,
                  interactive-rebase automation (squash/reorder/reword/drop) via a GIT_SEQUENCE_EDITOR shim,
                  stash, tags, worktrees, submodules, LFS, signing, repository health;
                  reflog.ts: HEAD reflog, the "undo last operation" planner and reset --keep;
                  bisect.ts: bisect state, start/mark/reset;
                  external-tools.ts: launches git difftool / mergetool without awaiting them
    gh/           GitHub CLI wrapper: device-flow login, repos, pull requests (incl. auto-merge), checks,
                  avatars, notifications inbox, gist settings sync;
                  accounts.ts: parses every signed-in account and builds the per-repository GH_TOKEN /
                  credential-helper environment injected into gh and network git commands
    ai/           backends.ts (Anthropic SDK + Claude CLI, scrubbing wrapper), openai-backend.ts
                  (OpenAI-compatible /chat/completions with json_schema -> json_object fallback), provider.ts
                  (picks the backend per feature, wraps it with usage recording and scrubbing),
                  usage.ts (monthly per-feature token totals in ai-usage.json), repo-guard.ts (refuses every
                  ai.* call for a repository with AI switched off), prompts, conflict resolver,
                  pull request AND pre-commit review service (review.ts, worktree target) and its
                  pure validation helpers (review-core.ts, shared by both),
                  diff explanation service (explain.ts) and its pure validation helpers (explain-core.ts),
                  and the other `<feature>.ts` + `<feature>-core.ts` pairs (splitter, rebasePlan, prDraft,
                  triage, release-notes, error-explain, nlPalette/nlPolicy),
                  agent handoff export (review-export.ts: JSON + Markdown written to <git-dir>/gitgood/review
                  after every run, read by terminal coding agents; see plugin/)
    update/       auto-update: UpdateProvider seam, electron-updater-backed provider, pure
                  semver/channel/reducer/gate logic (update-core.ts), orchestration (updater.ts)
    repo/         repository list, Git-pruned directory watcher in a worker thread,
                  watched folders: a pure bounded directory walker (scan.ts) plus the scan
                  orchestration, exclusions and folder validation (watched-folders.ts); path
                  comparison with the platform's case rules and the symlink-safe repository file
                  read/write helpers live in paths.ts; config.ts reads .gitgood/config.json
    settings/     portable settings export/import (sync-core.ts: allowlist, validation, merge/replace)
    integrations/ external editors and terminals per platform (shell-command.ts: running a command in a
                  new terminal window for "Fix with agent")
    protocol.ts   gitgood:// and x-github-client:// URL parsing (openRepo, review/rerun deep link)
    ipc.ts        registers every API method on Electron IPC; each invoke runs in its window's client context
    window.ts     BrowserWindow creation (one per window, only the first remembers its bounds)
    menu.ts       native menu, accelerators taken from the user's shortcut overrides
    client.ts     client mode: the desktop window runs a GitGood server's UI and answers native capabilities
    local-server.ts  the desktop-managed background server (systemd unit / LaunchAgent / Windows login item)
  server/         headless server: HTTP + WebSocket transport over the same core/ handlers
                  (security.ts: token, Tailscale identity, host/origin checks, path confinement; limits.ts:
                  which methods mutate and need the repository lock; web-bridge.ts: the script that gives the
                  browser the `window.gitgood` API, with reconnect backoff and version-skew detection;
                  web-host.ts: browser-side host, native-only capabilities throw "unsupported")
  mcp/            stdio MCP server for coding agents (latest review, request re-review, open repository);
                  dependency-free, built to out/mcp/index.mjs and launched by the gitgood-review plugin
  preload/        contextBridge exposing a single typed invoke/on bridge (plus webUtils.getPathForFile)
  renderer/       React UI (no UI framework dependencies); state/ holds the store and actions, heavy
                  dialogs and syntax-highlighting grammars load lazily
  shared/         types, IPC contract, pure logic used by both processes:
                  diff/ (unified diff parser, partial-patch builder, intraline word diff, conflict marker parser),
                  graph.ts (commit-graph lane layout, incremental per page),
                  shortcuts.ts (shortcut table, overrides merge, conflict detection, accelerator parsing),
                  secrets.ts (scrubSecrets token masking, secret-shaped file detection),
                  ai-model.ts (modelFor: per-feature model override), agent-presets.ts, util.ts
```

Renderer and main process communicate over one typed channel (`src/shared/ipc.ts`). All git commands run with `GIT_TERMINAL_PROMPT=0`, so nothing ever blocks on a hidden prompt; errors are classified (auth, network, non-fast-forward, conflicts, protected branch, …) to drive the right dialog.

Repository watching runs in `repo/watcher-worker.ts`; `watcher.ts` only owns the worker and forwards coalesced change notifications. Git enumerates cached and non-ignored files, preserving tracked files inside ignored directories and honoring nested, negated, global and repository-local ignore rules. Only their containing directories and relevant Git metadata directories receive non-recursive `fs.watch` subscriptions; ignored output trees and Git object storage are not recursively scanned. Git commands, file metadata comparisons, directory subscription updates and polling all stay off the Electron main thread.

Native events trigger bounded 120 ms reconciliation. A four-second reconciliation also detects missed events, changes to external ignore rules and files added inside previously empty directories; submodule dirty status is refreshed on reconciliation. If native watching fails, the same worker continues polling. File metadata includes nanosecond modification/change times, so editing an already-modified file still refreshes its diff. Switching repositories stops the old worker and suppresses late notifications; shutdown aborts its Git child. electron-vite's `?nodeWorker` import bundles the worker alongside the main entry, including in ASAR packages.

History, changes, and text diffs window their rendered rows. `TextDiff` computes word-level changes only when either row of a paired deletion/addition renders, caches both sides, and invalidates them when the hunks or word-highlighting setting change. Syntax highlighting remains lazy per 400-line block.

## Clients, windows and servers

Every call into the core runs inside a *client context* (`core/client-context.ts`): a web tab of the server, and each desktop window (`window-<webContents id>`, assigned in `ipc.ts`), is its own client. Per-client state — the repository watcher, an in-flight history load, AI jobs (`ai.cancel(feature)` aborts only the caller's own) — is keyed by it. Events are routed the same way (`core/event-routing.ts`): `repo.changed` reaches only the windows that have that repository open, progress and AI streams only the window that started them, and everything else (repository list, settings, tools, inbox, updates) reaches all windows. A second window opens through `app.newWindow`, passing the repository id in the URL fragment; menu actions, `gitgood://` links and `gitgood <path>` go to the focused window.

A handler whose first argument is an absolute path also runs inside a *repository scope*, so a `gh` or network `git` call made deep inside a service uses that repository's chosen GitHub account without every caller passing it along.

AI requests pass through three chokepoints so new features inherit them: `provider.ts` wraps every backend with usage recording and secret scrubbing (except conflict resolution, whose text is written back to the file), `ai/repo-guard.ts` rejects any `ai.*` method for a repository with AI disabled, and repository files that reach a prompt are read with `repo/paths.ts` so a symlink can never smuggle in outside content.

See [DEVELOPMENT.md](DEVELOPMENT.md) for how to build and test this, and [RELEASING.md](RELEASING.md) for how packaged builds and releases work.
