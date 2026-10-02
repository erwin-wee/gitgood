/**
 * The browser-side `window.gitgoodBridge`, mirroring `src/preload/index.ts`
 * but over `fetch` (invoke) and a WebSocket (events) instead of Electron IPC.
 * Served as a classic script in the document head so it runs before the app
 * module bundle; `src/renderer/src/api.ts` consumes it unchanged. The bearer
 * token and platform are prepended by the server as `window.__GITGOOD__`
 * (not inline in the HTML: the renderer CSP is `script-src 'self'`).
 * In the desktop client (`src/main/client.ts`), `window.gitgoodNative` answers
 * native capabilities first and adds window/menu events.
 */
export const WEB_BRIDGE_JS = `(function () {
  var cfg = window.__GITGOOD__ || {};
  var token = cfg.token || '';
  // Stable across reloads of this tab, so the server keeps this page's repository watcher through a reload or a brief disconnect.
  var clientId = sessionStorage.getItem('gitgood.client');
  if (!clientId) {
    clientId = (window.crypto && crypto.randomUUID && crypto.randomUUID()) || (String(Date.now()) + Math.random().toString(36).slice(2));
    sessionStorage.setItem('gitgood.client', clientId);
  }
  // The repository this page has open, re-opened after a reconnect in case the server released it meanwhile.
  var openRepo = null;
  var listeners = new Set();
  var native = window.gitgoodNative || null;
  function emit(name, payload) { listeners.forEach(function (l) { l(name, payload); }); }
  if (native) native.onEvent(emit);
  else {
    // The renderer refreshes status on focus; the desktop preload reports it, a browser tab reports it here.
    var reportFocus = function () { emit('window.focus', { focused: document.visibilityState === 'visible' && document.hasFocus() }); };
    document.addEventListener('visibilitychange', reportFocus);
    window.addEventListener('focus', reportFocus);
    window.addEventListener('blur', reportFocus);
  }
  var connectedBefore = false;
  var connected = true;
  var attempt = 0;
  var socket = null;
  function setConnected(next) {
    if (connected === next) return;
    connected = next;
    emit('server.connection', { connected: next });
  }
  // The desktop client watches the server version itself (src/main/client.ts); a browser tab compares on reconnect.
  function checkServerVersion() {
    if (native || !cfg.version) return;
    fetch('/version', { cache: 'no-store' }).then(function (res) { return res.ok ? res.json() : null; }).then(function (body) {
      if (body && body.version && body.version !== cfg.version) emit('server.updated', { version: body.version });
    }, function () {});
  }
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(proto + '//' + location.host + '/events?token=' + encodeURIComponent(token) + '&client=' + encodeURIComponent(clientId));
    socket.onopen = function () {
      attempt = 0;
      setConnected(true);
      // Events sent while disconnected are lost: re-open the repository and let the renderer refresh (it does so when focused;
      // an unfocused page refreshes on its next focus event).
      if (connectedBefore) {
        (openRepo ? httpInvoke('repo.open', [openRepo]) : Promise.resolve()).then(function () { emit('window.focus', { focused: document.visibilityState === 'visible' && document.hasFocus() }); });
        checkServerVersion();
      }
      connectedBefore = true;
    };
    socket.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      emit(msg.event, msg.payload);
      if (native && (msg.event === 'gh.inbox.changed' || msg.event === 'gh.inbox.new')) native.serverEvent(msg.event, msg.payload);
    };
    socket.onclose = function () {
      setConnected(false);
      // 1s, 2s, 4s ... capped at 30s, so a server that is down for a while is not hammered.
      setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, attempt++)));
    };
    socket.onerror = function () { try { socket.close(); } catch (e) {} };
  }
  connect();
  function httpInvoke(method, args) {
    return fetch('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-GitGood-Client': clientId },
      body: JSON.stringify({ method: method, args: args }),
    }).then(function (res) {
      if (!res.ok) {
        return { ok: false, error: { message: 'Server returned ' + res.status, command: '', exitCode: null, stderr: '', stdout: '', code: res.status === 401 ? 'auth-failed' : 'unknown' } };
      }
      return res.json();
    }, function (err) {
      return { ok: false, error: { message: String((err && err.message) || err), command: '', exitCode: null, stderr: '', stdout: '', code: 'network' } };
    });
  }
  // The folder picker is a dialog of the React app (ServerFolderPicker): it answers by calling done.
  function pickDirectory(opts) {
    return new Promise(function (resolve) {
      emit('server.pickDirectory', { opts: opts, done: function (value) { resolve({ ok: true, value: value }); } });
    });
  }
  function webInvoke(method, args) {
    var ok = { ok: true, value: undefined };
    if (method === 'repo.open') openRepo = args[0];
    else if (method === 'repo.close' && openRepo === args[0]) openRepo = null;
    var unsupported = function (msg) { return Promise.resolve({ ok: false, error: { message: msg, command: '', exitCode: null, stderr: '', stdout: '', code: 'unsupported' } }); };
    // Web stories for host-only capabilities: run them in the browser instead of round-tripping to the server.
    if (method === 'app.clipboard.write') {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(args[0]).then(function () { return ok; }, function () { return unsupported('Clipboard write was blocked by the browser.'); });
      return unsupported('Clipboard is not available in this browser.');
    }
    if (method === 'app.openExternal') { window.open(args[0], '_blank', 'noopener,noreferrer'); return Promise.resolve(ok); }
    if (method === 'app.chooseDirectory') return pickDirectory(args[0] || {});
    // Editor/terminal integrations run on the server's machine: a browser may be elsewhere, so only the desktop client (which blocks them for remote servers) sends them.
    if (!native && method === 'app.openInEditor') return unsupported('Open in editor is only available in the desktop app.');
    if (!native && method === 'app.openInShell') return unsupported('Open in terminal is only available in the desktop app.');
    if (!native && (method === 'app.openDiffTool' || method === 'app.openMergeTool')) return unsupported('External diff and merge tools are only available in the desktop app.');
    return httpInvoke(method, args);
  }
  window.gitgoodBridge = {
    platform: cfg.platform || 'linux',
    invokeRaw: function (method) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (!native) return webInvoke(method, args);
      return native.invoke(method, args).then(function (res) { return res || webInvoke(method, args); });
    },
    on: function (event, listener) {
      var wrapped = function (name, payload) { if (name === event) listener(payload); };
      listeners.add(wrapped);
      return function () { listeners.delete(wrapped); };
    },
  };
})();
`;

/** The head snippet the server injects before the app bundle. External only: inline scripts violate the CSP. */
export const BRIDGE_TAG = '<script src="/gitgood-bridge.js"></script>';

/**
 * `/gitgood-bridge.js` embeds the token, so a page on another origin must not be able to include it: browsers
 * label such requests `Sec-Fetch-Site: cross-site|same-site`. Same-origin loads, address-bar navigation (`none`)
 * and clients that send no fetch metadata (the desktop client's Node fetch) pass.
 */
export function bridgeFetchAllowed(secFetchSite: string | string[] | undefined): boolean {
  return secFetchSite === undefined || secFetchSite === 'same-origin' || secFetchSite === 'none';
}

/** The served `/gitgood-bridge.js`: config globals followed by the bridge. */
export function bridgeScript(token: string, platform: string, version: string): string {
  return `window.__GITGOOD__=${JSON.stringify({ token, platform, version })};\n${WEB_BRIDGE_JS}`;
}
