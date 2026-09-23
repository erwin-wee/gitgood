# Add GitGood Server Mode (web access over the tailnet)

## Why

GitGood today is Electron-only: the renderer runs inside a `BrowserWindow` and every
operation reaches the Node backend through Electron IPC (`ipcRenderer.invoke` /
`webContents.send`) exposed by the preload `contextBridge` as `window.gitgoodBridge`.
There is no HTTP listener, so GitGood cannot be reverse-proxied to a tailnet host the way
a normal web app is with `tailscale serve`. Users who want to reach their GitGood on a
headless or remote machine currently have no option short of full remote-desktop.

The renderer↔backend contract is already a single clean seam — `invoke(method, ...args)`
request/response plus `on(event, cb)` server-push, both defined once in
`src/shared/ipc.ts` (`ApiMethods`, `EventPayloads`, `IPC_INVOKE_CHANNEL`,
`IPC_EVENT_CHANNEL`) and wrapped by `src/renderer/src/api.ts`. That makes a network
transport a swap at one layer rather than a rewrite of the app. The cost is not the
transport; it is doing the security, the Electron decoupling, and the desktop-affordance
gaps correctly.

## What Changes

- Add a **server mode**: a Node HTTP/WebSocket server (no Electron) that hosts the
  existing backend handlers and serves the built renderer as a web app, so GitGood is
  reachable at `https://<host>.<tailnet>.ts.net` behind `tailscale serve`.
- Extract the backend from Electron: the `handlers` registry (`src/main/ipc.ts`) and the
  event emitter (`sendEvent`) become an Electron-free core both the desktop app and the
  server mount. Native calls (`shell`, `dialog`, `Menu`, `Tray`, `nativeTheme`,
  `autoUpdater`, `BrowserWindow`) move behind a `HostCapabilities` interface with an
  Electron implementation and a web implementation.
- Add a **web bridge shim** that defines `window.gitgoodBridge` over `fetch` (invoke) and
  a WebSocket (events), mirroring `src/preload/index.ts`, so `api.ts` and every existing
  caller are unchanged.
- **[User-confirmed / security-sensitive]** Exposing the backend over a network is remote
  execution of `git`/`gh`/shell/AI-CLI as the host user. Server mode SHALL bind only to
  `127.0.0.1` (never `0.0.0.0`), require authentication on both the invoke and event
  channels, authorize against the forwarded Tailscale identity header, and confine repo
  operations to the registered-repository allowlist.
- Desktop-only handlers degrade gracefully in web mode (return an `unsupported` result)
  until a per-feature web story exists (later phase).
- The desktop app can run as a client of a server, sharing one set of settings and
  repositories across devices, and warns on a version mismatch.
- A phone layout for the web UI (single pane, bottom tab bar, back gesture, long-press
  menus) and an installable web manifest.

## Impact

- Affected specs: new capability `server-mode`.
- Affected code:
  - `src/shared/ipc.ts` — the IPC contract is the transport-neutral interface both
    transports implement; `IpcResult` stays the wire shape.
  - `src/main/ipc.ts` — extract the `handlers` map and `sendEvent` into an Electron-free
    core module; the Electron `ipcMain.handle(IPC_INVOKE_CHANNEL, …)` and
    `win.webContents.send(IPC_EVENT_CHANNEL, …)` become one binding of that core.
  - `src/main/window.ts`, `src/main/index.ts`, `src/main/menu.ts`, tray, updater — the
    Electron-specific host surface, moved behind `HostCapabilities`.
  - `src/preload/index.ts` — the reference bridge the web shim mirrors.
  - `src/renderer/src/api.ts` — unchanged; it consumes whichever `window.gitgoodBridge`
    is present.
  - New `src/server/` — HTTP `POST /invoke`, WebSocket `/events`, static hosting of
    `out/renderer`, auth + Tailscale-identity authorization, repo-path allowlist.
  - `electron.vite.config.*` / build scripts — a server build target that must not import
    `electron`.
- External commands: no new `git`/`gh` commands; server mode reuses the existing
  `src/main/git` and `src/main/gh` wrappers unchanged (all runs keep
  `GIT_TERMINAL_PROMPT=0`).
- No new runtime dependency is assumed; the HTTP/WS server SHOULD use the Node standard
  library (`node:http`, a minimal WS implementation) — any candidate dependency requires a
  dependency-review task first (four-dependency budget).
