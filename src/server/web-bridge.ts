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
  var clientId = (window.crypto && crypto.randomUUID && crypto.randomUUID()) || (String(Date.now()) + Math.random().toString(36).slice(2));
  var listeners = new Set();
  var native = window.gitgoodNative || null;
  function emit(name, payload) { listeners.forEach(function (l) { l(name, payload); }); }
  if (native) native.onEvent(emit);
  var socket = null;
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(proto + '//' + location.host + '/events?token=' + encodeURIComponent(token) + '&client=' + encodeURIComponent(clientId));
    socket.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      emit(msg.event, msg.payload);
      if (native && (msg.event === 'gh.inbox.changed' || msg.event === 'gh.inbox.new')) native.serverEvent(msg.event, msg.payload);
    };
    socket.onclose = function () { setTimeout(connect, 1000); };
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
  function pickDirectory(opts) {
    return new Promise(function (done) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font:13px system-ui,-apple-system,sans-serif';
      var modal = document.createElement('div');
      modal.style.cssText = 'background:#1f1f1f;color:#eee;width:min(560px,92vw);max-height:72vh;display:flex;flex-direction:column;border-radius:8px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.6)';
      var header = document.createElement('div');
      header.style.cssText = 'padding:12px 16px;font-weight:600;border-bottom:1px solid #333';
      header.textContent = (opts && opts.title) || 'Choose a folder on the server';
      var crumb = document.createElement('input');
      crumb.placeholder = 'Type a path and press Enter';
      crumb.spellcheck = false;
      crumb.style.cssText = 'margin:8px 16px;padding:6px 8px;background:#111;color:#8ab4f8;border:1px solid #333;border-radius:4px;font:12px ui-monospace,monospace';
      var status = document.createElement('div');
      status.style.cssText = 'padding:0 16px 8px;color:#f28b82;font-size:12px;border-bottom:1px solid #333';
      var list = document.createElement('div');
      list.style.cssText = 'flex:1;overflow:auto;min-height:220px';
      var footer = document.createElement('div');
      footer.style.cssText = 'padding:10px 16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #333';
      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding:6px 14px;cursor:pointer';
      var selectBtn = document.createElement('button');
      selectBtn.textContent = 'Select';
      selectBtn.style.cssText = 'padding:6px 14px;cursor:pointer';
      footer.appendChild(cancelBtn);
      footer.appendChild(selectBtn);
      modal.appendChild(header);
      modal.appendChild(crumb);
      modal.appendChild(status);
      modal.appendChild(list);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      var current = null;
      function finish(value) { document.body.removeChild(overlay); done({ ok: true, value: value }); }
      cancelBtn.onclick = function () { finish(null); };
      // A typed but not yet opened path is opened (and so validated) before it is selected.
      selectBtn.onclick = function () {
        var typed = crumb.value.trim();
        if (typed && typed !== current) render(typed, function () { finish(current); });
        else finish(current);
      };
      crumb.onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); render(crumb.value.trim() || null); }
        else if (e.key === 'Escape') finish(null);
      };
      function row(label) {
        var d = document.createElement('div');
        d.textContent = label;
        d.style.cssText = 'padding:8px 16px;cursor:pointer;border-bottom:1px solid #262626';
        d.onmouseenter = function () { d.style.background = '#2a2a2a'; };
        d.onmouseleave = function () { d.style.background = ''; };
        return d;
      }
      function render(path, then) {
        httpInvoke('app.listDir', [path]).then(function (res) {
          if (!res.ok) { status.textContent = res.error.message; return; }
          status.textContent = '';
          current = res.value.path;
          crumb.value = current || '';
          selectBtn.disabled = !current;
          if (then) return then();
          list.innerHTML = '';
          if (res.value.parent !== null || current) {
            var up = row('\u2190 Up');
            up.onclick = function () { render(res.value.parent); };
            list.appendChild(up);
          }
          res.value.entries.forEach(function (e) {
            var r = row('\uD83D\uDCC1 ' + e.name);
            r.onclick = function () { render(e.path); };
            list.appendChild(r);
          });
          if (!res.value.entries.length) {
            var empty = row('(no subfolders)');
            empty.style.opacity = '.5';
            empty.style.cursor = 'default';
            list.appendChild(empty);
          }
        });
      }
      render(null);
    });
  }
  function webInvoke(method, args) {
    var ok = { ok: true, value: undefined };
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

/** The served `/gitgood-bridge.js`: config globals followed by the bridge. */
export function bridgeScript(token: string, platform: string): string {
  return `window.__GITGOOD__=${JSON.stringify({ token, platform })};\n${WEB_BRIDGE_JS}`;
}
