# Design: GitGood Server Mode

## Context

The renderer never touches Electron directly. The only coupling is `window.gitgoodBridge`
(`src/preload/index.ts`), consumed exclusively by `src/renderer/src/api.ts`:

- `invokeRaw(method, ...args): Promise<unknown>` → `ipcRenderer.invoke(IPC_INVOKE_CHANNEL, method, ...args)`
- `on(event, cb): () => void` → `ipcRenderer.on(IPC_EVENT_CHANNEL, …)`
- `platform: string`

Main-side dispatch is one handler over a plain map:
`ipcMain.handle(IPC_INVOKE_CHANNEL, (_e, method, ...args) => handlers[method](...args))`
returning `IpcResult<T>` (`{ok:true, value}` | `{ok:false, error: GitErrorInfo}`,
`src/main/ipc.ts:1038`). Events go out via `sendEvent(win, event, payload)` →
`win.webContents.send(IPC_EVENT_CHANNEL, event, payload)` (`ipc.ts:76`).

Therefore server mode swaps the transport under `api.ts` and reuses everything above it.
The engineering is in decoupling, security, and desktop-affordance gaps — not the wire.

## Goals / Non-goals

- Goals: run the real GitGood UI at `https://<host>.ts.net` over the tailnet; reuse the
  existing handlers and git/gh/ai wrappers verbatim; keep the desktop app fully working
  and green at every step.
- Non-goals (this change): public-internet exposure / `tailscale funnel`; multi-user
  tenancy; replacing Electron.

## Decisions

### 1. Electron-free core (`HostCapabilities`)

Extract two things from `src/main/ipc.ts` into an Electron-free module (e.g.
`src/main/core/handlers.ts`):

- `createHandlers(deps): Record<ApiMethodName, (...args) => Promise<unknown>>` — the exact
  existing map, unchanged in behavior.
- An event bus `emit(event, payload)` replacing direct `win.webContents.send`. `sendEvent`
  becomes a thin adapter that publishes to the bus; the Electron app subscribes and
  forwards to its window, the server subscribes and forwards to connected sockets.

Native/host operations move behind a `HostCapabilities` interface:

```
interface HostCapabilities {
  chooseDirectory(opts): Promise<string | null>;
  openExternal(url): Promise<void>;
  showItemInFolder(path): Promise<void>;
  openInEditor(path) / openInTerminal(path): Promise<void>;
  clipboardWrite(text): Promise<void>;
  notify(title, body): Promise<void>;
  setTheme(theme) / systemTheme(): ...;
  // menu, tray, updater, window controls, protocol handler, single-instance
}
```

- `ElectronHost` implements it with `dialog`/`shell`/`Menu`/`Tray`/`nativeTheme`/
  `autoUpdater`.
- `WebHost` implements the network-safe subset and returns a typed `unsupported` result
  for the rest (renderer already tolerates rejected invokes via `ApiError`). Semantics
  that differ (a "directory" is on the *server*) are documented per capability.

Rationale: no handler should transitively import `electron`, so the server bundle stays
Electron-free. This is the load-bearing refactor; it changes no behavior.

### 2. Transport

- **Invoke:** `POST /invoke` with `{method, args}` JSON → `handlers[method](...args)` →
  the same `IpcResult` JSON the desktop returns. One route; the typed `ApiMethods` map is
  the contract.
- **Events:** a single WebSocket `/events`; the server subscribes to the core event bus
  and pushes `{event, payload}` frames. (SSE is an alternative; WebSocket chosen for
  symmetry and future client→server needs.)
- **Web bridge shim** (`src/server/web-bridge.ts`, served before the app bundle): defines
  `window.gitgoodBridge = { platform, invokeRaw: fetch→/invoke, on: WS subscription }`,
  mirroring `preload/index.ts`. `api.ts` is unchanged.
- `platform` in web mode reports the **server** platform (git path semantics are the
  server's); the renderer already keys Windows/CRLF handling off it, which is correct
  because the repos live on the server.

### 3. Security (mandatory)

Server mode is remote code execution as the host user; the following are requirements,
not options:

- **Bind `127.0.0.1` only.** `tailscale serve` is the sole ingress (tailnet-only,
  matching the existing openspectacles setup); the raw port is never on `0.0.0.0`.
- **Authenticate both channels.** A bearer token (generated on first server start, stored
  in the app's user-data dir, shown once) gates `/invoke` and the `/events` upgrade.
- **Authorize by Tailscale identity.** `tailscale serve` forwards `X-Forwarded-For` and,
  for user-owned devices, `Tailscale-User-Login`. Any forwarded request (static pages and
  `/gitgood-bridge.js` included, since the bridge carries the token) must carry exactly the
  allowed login: `GITGOOD_ALLOWED_LOGIN`, else the node owner from `tailscale status
  --json`. Tagged devices (no login header), other users, and every forwarded request
  when no login is known are refused. Direct loopback calls (no forwarding headers) are
  the desktop client and local tooling and rely on the token.
- **Host allowlist.** Only `127.0.0.1`, `localhost`, `[::1]` and `*.ts.net` `Host`
  headers are answered, so a DNS-rebinding page cannot read the served token.
- **Confine paths.** Handlers take repo paths as arguments; the server rejects any
  absolute path argument outside the allowlisted roots (registered repositories, watched
  folders, default clone directory, the server user's home, `GITGOOD_ALLOWED_ROOTS`).
  Home is included so the web folder picker can add repositories that are not registered
  yet. Gated centrally at the dispatch boundary.
- **Same-origin / CSRF** on the WebSocket upgrade and a strict `Content-Type` on
  `/invoke`.

### 4. Multi-client

`sendEvent` today assumes one window. The core bus fans out to N subscribers; the server
broadcasts each event to all connected sockets. Phase 1 ships a **single-active-client
advisory lock** (a second client is read-only or warned) to avoid concurrent-mutation
surprises; full multi-client correctness (per-client view state, optimistic conflict
handling) is a later phase.

### 5. Packaging

`vite.server.config.ts` bundles `src/server` + the Electron-free core into
`out/server/index.mjs`, fails the build on any `electron` import, and bakes in the
package version (the service runs the file directly, without npm). `npm run build`
builds it alongside the desktop app, so installers carry it and it can run under the
app's own runtime with `ELECTRON_RUN_AS_NODE=1`. `npm run install:service` writes a
systemd user unit for a checkout. CI builds the bundle on every push.

### 6. Desktop app as a client

With `GITGOOD_SERVER_URL` or `<userData>/server-url` set, the desktop window loads the
server's renderer and web bridge instead of running its own backend, so one set of
settings and repositories serves every device. `src/main/client.ts` answers the native
capabilities (clipboard, links, zoom, badge, notifications; plus dialogs, reveal and
editor/terminal when the server is on the same machine) before the bridge falls back to
its web path. The window runs the server's renderer against this build's native IPC, so
the desktop fetches `GET /version` after each load and warns once on a mismatch.

### 7. Phone layout

Below 768px the renderer switches to one pane at a time (`Mobile.tsx`): a bottom tab
bar, tap-to-drill-in lists mirrored into browser history so the system back gesture
pops a level, bottom-sheet pickers/dialogs/menus, and long-press opening context menus
(iOS Safari never fires `contextmenu`). A web manifest and icons make it installable to
the home screen. Desktop widths are unchanged.

## Risks / tradeoffs

- **Decoupling churn:** touching `ipc.ts` and the host surface risks regressions in the
  desktop app — mitigated by keeping `ElectronHost` behavior identical and running
  typecheck/tests/smoke after each group.
- **Affordance semantics:** "open in editor/terminal" runs on the server; users must
  understand server-vs-client filesystem. Phase 1 marks these `unsupported`; Phase 2 gives
  each a real web story rather than a surprising one.
- **Security is the failure mode:** a missing check is an RCE. The path allowlist and
  identity check are gated at one dispatch boundary so they cannot be bypassed per-handler.

## Migration / phasing

- Phase 0: Electron-free core + `HostCapabilities` (no behavior change).
- Phase 1: thin secure server (transport + shim + auth + identity + allowlist + static),
  desktop-only handlers return `unsupported`.
- Phase 2: web stories for the affordance gaps (server-side directory picker, clipboard,
  external links, editor/terminal decisions).
- Phase 3: multi-client broadcast + hardening.
- Phase 4: desktop-as-client, phone layout, packaging and identity/host hardening.
