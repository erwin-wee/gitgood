# Server Mode Specification

## Purpose

Lets GitGood run headless as a web server reachable over the user's tailnet, so the same UI and git/gh backend work from a browser, a phone, or a desktop app acting as a client, without exposing the host beyond the authorized Tailscale identity.

## Requirements

### Requirement: Web-accessible backend transport

GitGood SHALL provide a server mode that hosts the existing backend handler registry over
HTTP and serves the built renderer as a web application, so the same UI is reachable in a
browser over the network without Electron.

The transport SHALL implement the existing IPC contract (`ApiMethods`, `EventPayloads`
from `src/shared/ipc.ts`) without changing method names, signatures, or the `IpcResult`
result shape, so the renderer and every `invoke(...)`/`on(...)` caller are unchanged.

#### Scenario: Invoke over HTTP returns the same result shape as Electron

- **WHEN** a browser client POSTs `{method, args}` to `/invoke` for a registered method
- **THEN** the server runs the same handler the desktop app runs and responds with the
  identical `IpcResult` (`{ok:true, value}` or `{ok:false, error}`)
- **AND** an unknown method name returns `{ok:false, error}` with a message naming the
  method, exactly as the Electron dispatch does today.

#### Scenario: Server-push events reach the browser

- **WHEN** the backend emits an event (e.g. `repo.changed`) that the desktop app would
  deliver via `webContents.send`
- **THEN** every connected browser client receives the same `{event, payload}` over the
  event channel
- **AND** the renderer's `on(event, cb)` fires with the same payload it would receive in
  the desktop app.

#### Scenario: The renderer runs unmodified against the web bridge

- **WHEN** the renderer loads in a browser served by server mode
- **THEN** `window.gitgoodBridge` is present with `invokeRaw`, `on`, and `platform`
  backed by the network transport
- **AND** `src/renderer/src/api.ts` and its callers operate without source changes.

### Requirement: Network exposure is bound to loopback behind an authenticated proxy

Because server mode executes `git`, `gh`, shell, and AI-CLI operations as the host user,
it SHALL NOT expose the backend without access control.

The server SHALL bind only to `127.0.0.1` and rely on an external reverse proxy
(`tailscale serve`) as the sole network ingress; it SHALL NOT bind to `0.0.0.0` or a
public interface, and it SHALL NOT enable public exposure (`tailscale funnel`) by default.

#### Scenario: Server refuses non-loopback binding

- **WHEN** server mode starts
- **THEN** it listens only on `127.0.0.1`
- **AND** it does not accept connections arriving directly on a non-loopback interface.

### Requirement: Authenticated and identity-authorized access

Server mode SHALL authenticate every request on both the invoke and event channels, and
SHALL authorize the caller against a configured identity.

A bearer token SHALL gate `/invoke` and the event-channel upgrade. Every request that
arrives through `tailscale serve` (identified by its forwarding headers), including the
page and bridge script that carry the token, SHALL carry a `Tailscale-User-Login` equal
to the allowed login (default: the node owner); requests without it, from other users or
tagged devices, SHALL be rejected. The server SHALL answer only loopback and `*.ts.net`
host names.

#### Scenario: Missing or wrong token is rejected

- **WHEN** a client calls `/invoke` or opens the event channel without the valid bearer
  token
- **THEN** the server rejects the request with an authentication error and runs no handler.

#### Scenario: Disallowed tailnet identity is rejected

- **WHEN** a request carries a valid token but a Tailscale identity not in the
  allowed-login set
- **THEN** the server rejects it and runs no handler.

#### Scenario: Forwarded request without an identity is rejected

- **WHEN** a request arrives through `tailscale serve` without a `Tailscale-User-Login`
  header (a tagged device), or no allowed login is configured or discoverable
- **THEN** the server rejects it, including requests for the page and bridge script.

#### Scenario: DNS-rebinding host is rejected

- **WHEN** a request carries a `Host` header that is not `127.0.0.1`, `localhost`,
  `[::1]` or a `*.ts.net` name
- **THEN** the server rejects it without serving the page, bridge or any handler.

### Requirement: Repository path confinement

Server mode SHALL confine filesystem access to allowlisted roots: registered
repositories, watched folders, the default clone directory, the server user's home and
any explicitly configured extra roots.

At the dispatch boundary, any absolute path argument SHALL be validated against those
roots; requests naming a path outside them SHALL be rejected before the handler runs.
Directory-enumeration and scan operations SHALL NOT escape the allowlisted roots.

#### Scenario: Operation on an unregistered path is refused

- **WHEN** a client invokes an operation with an absolute path outside every allowlisted
  root
- **THEN** the server rejects it with an error and does not execute any git/gh/shell
  command against that path.

### Requirement: Graceful degradation of desktop-only capabilities

Capabilities that depend on the local desktop (native file/dir pickers, open-in-editor,
open-in-terminal, show-in-folder, native menu, tray, auto-update, window controls,
protocol handling) SHALL be provided through a host-capability abstraction with an
Electron implementation and a web implementation.

Where a capability has no safe web equivalent yet, the web implementation SHALL return a
typed `unsupported` result rather than crash or execute an unintended host action; entry
points remain visible per existing conventions and surface the unsupported state to the
user.

#### Scenario: Unsupported desktop action degrades cleanly in the browser

- **WHEN** a browser client invokes a capability with no web implementation (e.g.
  open-in-terminal)
- **THEN** the server returns a typed `unsupported` result
- **AND** the renderer reports it via the normal error path without breaking the session.

### Requirement: The desktop application is unaffected

Introducing server mode SHALL NOT change the behavior of the Electron desktop application.

The Electron app SHALL continue to use the Electron host implementation and IPC transport,
and its externally observable behavior SHALL remain unchanged across the refactor.

#### Scenario: Desktop app behavior is preserved

- **WHEN** GitGood runs as the Electron desktop app after server mode is added
- **THEN** all existing flows behave as before
- **AND** `npm run typecheck` and `npm test` pass and a smoke pass of the desktop app
  succeeds.

### Requirement: Desktop app as a server client

The desktop app SHALL be able to run as a client of a GitGood server, configured by
`GITGOOD_SERVER_URL` or a `server-url` file in its user-data directory, loading the
server's UI so settings and repositories are shared with every other client. Native
capabilities SHALL stay native; filesystem-bound ones (dialogs, reveal, editor, terminal)
only when the server runs on the same machine.

#### Scenario: Version mismatch is surfaced

- **WHEN** the desktop app connects to a server reporting a different version on
  `GET /version`
- **THEN** the desktop warns once that the versions differ.

### Requirement: Phone layout

On viewports narrower than 768px the web UI SHALL show one pane at a time with a bottom
tab bar, drill-in navigation that the browser back gesture reverses, and long-press to
open context menus. Wider viewports SHALL keep the existing layout.

#### Scenario: Drill-in and back on a phone

- **WHEN** a user on a phone taps a changed file
- **THEN** its diff replaces the list
- **AND** the system back gesture returns to the list.
