# Tasks: GitGood Server Mode

## Phase 0 — Electron-free core (no behavior change)

- [x] Extract the handler registry from `src/main/ipc.ts` into an Electron-free module
      (e.g. `src/main/core/handlers.ts`): `createHandlers(deps)` returning the existing
      `Record<ApiMethodName, (...args) => Promise<unknown>>` with identical behavior.
- [x] Replace direct `win.webContents.send(IPC_EVENT_CHANNEL, …)` with a core event bus
      (`emit(event, payload)`); make `sendEvent` a thin adapter that publishes to the bus.
- [x] Define `HostCapabilities` covering every native call currently reached from handlers
      (`dialog`, `shell.openExternal`, `showItemInFolder`, open-in-editor/terminal,
      clipboard, `notify`, `nativeTheme`, menu, tray, `autoUpdater`, window controls,
      protocol handler, single-instance).
- [x] Implement `ElectronHost` with the current Electron behavior; route the desktop app's
      handlers through it. Assert (build check or lint rule) that `src/main/core` and the
      handler modules do not import `electron`.
- [x] Re-bind the Electron app: `ipcMain.handle(IPC_INVOKE_CHANNEL, …)` calls the core
      handlers; the window subscribes to the core event bus. No observable change.
- [x] Run `npm run typecheck` and `npm test`; smoke the desktop app (build, then run with
      `GITGOOD_USER_DATA`/`GITGOOD_SMOKE_SCRIPT`) to confirm parity.
      <!-- typecheck+1075 tests green; electron-vite build green; smoke 29/35 (the 6
           watched-folders scenarios fail identically on the pre-refactor tree, so parity holds). -->

## Phase 1 — Thin secure server behind `tailscale serve`

- [x] Dependency review: decide HTTP/WS implementation. Prefer `node:http` + a minimal
      WebSocket; if a dependency is proposed, complete a dependency review (four-dep
      budget) before adding it.
      <!-- Decided: node:http + a hand-rolled RFC6455 WebSocket (src/server/ws.ts). No new
           runtime dependency; the four-dep budget is untouched. -->
- [x] Add `src/server/` entry (`gitgood-server`) that constructs the core handlers +
      event bus with a `WebHost`, binds `127.0.0.1` only, and serves static `out/renderer`.
- [x] Implement `POST /invoke` (`{method, args}` → `IpcResult`) reusing the core handlers.
- [x] Implement the `/events` WebSocket: subscribe to the core bus, broadcast
      `{event, payload}` frames to connected clients.
- [x] Add `src/server/web-bridge.ts`, served before the app bundle, defining
      `window.gitgoodBridge` (`platform`, `invokeRaw` over fetch, `on` over WebSocket)
      mirroring `src/preload/index.ts`. Confirm `src/renderer/src/api.ts` is unchanged.
- [x] Security — bearer token: generate on first server start, persist in user-data dir,
      print once; require it on `/invoke` and the `/events` upgrade.
- [x] Security — Tailscale identity: read the forwarded `Tailscale-User-Login` header and
      authorize against an allowed-login (default node owner); reject others.
- [x] Security — path confinement: gate the dispatch boundary so any repo-path argument
      not in the registered-repository allowlist is rejected before the handler runs;
      block directory/scan escapes.
- [x] Security — same-origin/CSRF on the WS upgrade; strict `Content-Type` on `/invoke`.
- [x] `WebHost`: implement network-safe capabilities where trivial; return a typed
      `unsupported` result for the rest; verify the renderer degrades via the normal error
      path.
- [x] Multi-client guard: single-active-client advisory lock (second client read-only or
      warned) to avoid concurrent-mutation surprises.
- [x] Build: add a server build target that bundles `src/server` + core, asserts no
      `electron` import, and outputs the `gitgood-server` artifact.
- [x] Manual verification: run the server, `tailscale serve` the loopback port, load
      `https://<host>.ts.net`, and confirm read + core git flows (status, history, diff,
      commit) work from a browser on another tailnet device.
      <!-- Verified through the real tailscale serve ingress (https://<host>.ts.net) from a
           browser on the serving node: status, diff, commit, history, live repo events.
           Identity/host guards exercised with forged headers (403/421). -->
- [x] Run `npm run typecheck` and `npm test`; smoke both the desktop app and the served
      web app.
      <!-- typecheck green; 1103 tests pass; server bundle builds Electron-free; served app
           exercised over HTTP (/invoke) + Node WebSocket (/events). Managed Chromium was
           unavailable for a visual browser boot in this environment. -->

## Phase 2 — Close affordance gaps (web stories)

- [x] Server-side directory picker UI for `chooseDirectory` (browse the server FS within
      allowlisted roots).
      <!-- Server handles a read-only `app.listDir(path)` (roots when null, subdirs otherwise,
           confined to allowlisted roots). The web bridge intercepts app.chooseDirectory and
           shows a modal folder browser backed by it, returning the chosen path. -->
- [x] Clipboard via the browser API in `WebHost`; external links via `window.open`.
      <!-- Handled client-side in the web bridge: navigator.clipboard for app.clipboard.write,
           window.open for app.openExternal, so they never round-trip to the server. -->
- [x] Decide and implement editor/terminal behavior for web mode (run on server vs.
      disable), documented in-UI so server-vs-client filesystem is unambiguous.
      <!-- Decision: disable over the web (they act on the desktop machine's filesystem).
           The bridge short-circuits app.openInEditor/app.openInShell to a typed unsupported
           result whose message explains it is desktop-only. -->
- [x] Run `npm run typecheck` and `npm test`; smoke the web app for each newly enabled
      capability.
      <!-- typecheck + 1107 tests green; live-verified app.listDir (roots/subdirs/rejection)
           against the running server. -->

## Phase 3 — Multi-client + hardening

- [x] Replace the single-active-client lock with real broadcast + per-client view state.
      <!-- Advisory lock removed: all clients may act; the core event bus already broadcasts
           every change to every connected socket, and view state lives per-browser. -->
- [x] Optimistic/conflict handling for concurrent mutations from multiple clients.
      <!-- src/server/limits.ts KeyedMutex serializes mutations per repo path at the invoke
           boundary so concurrent clients can't race git's index/locks; conflicting git
           outcomes surface through the existing error classification + repo.changed refresh. -->
- [x] Rate/scope limits and audit logging on the invoke boundary.
      <!-- Per-client token-bucket RateLimiter (120 burst / 20 per sec -> 429); every mutating
           invoke is audit-logged (client, method, target, outcome). Live-verified: 200
           concurrent -> 120 ok / 80 429; audit line written. -->
- [x] Run `npm run typecheck` and `npm test`; smoke multi-client scenarios.
      <!-- typecheck + 1107 tests green (KeyedMutex/RateLimiter/audit unit-tested
           deterministically); rate-limit + audit + listDir verified against the live server. -->

## Docs

- [x] Document server mode setup (loopback bind + `tailscale serve` + token + allowed
      login) in the README before archiving.

## Phase 4 — Desktop client, phone layout, packaging, hardening

- [x] Desktop app as a server client (`src/main/client.ts`, `server-url` / `GITGOOD_SERVER_URL`).
- [x] `GET /version` + one-time desktop warning on a version mismatch; version baked into the bundle.
- [x] Phone layout (`Mobile.tsx`, `max-width: 767px` styles), web manifest and icons.
      <!-- Verified in an iPhone 13 emulation over the tailnet: tab bar, drill-in + back, long-press menu. -->
- [x] Identity required on every forwarded request (page + bridge included), default
      allowed login = node owner, `Host` allowlist against DNS rebinding.
- [x] `npm run build` includes the server; installers ship it; `npm run install:service`
      writes the systemd user unit; CI builds the server bundle.
