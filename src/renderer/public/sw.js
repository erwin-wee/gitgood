const CACHE_NAME = 'gitgood-assets-v1';
const MAX_ASSETS = 12;
const BYPASS_PATHS = new Set(['/invoke', '/gitgood-bridge.js', '/version', '/events']);
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>GitGood offline</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
        padding: 1.5rem;
        box-sizing: border-box;
        background: #f6f8fa;
        color: #1f2328;
        font: 16px/1.5 system-ui, -apple-system, sans-serif;
        text-align: center;
      }
      main { max-width: 28rem; }
      button {
        border: 0;
        border-radius: 0.5rem;
        padding: 0.65rem 1rem;
        background: #0969da;
        color: white;
        cursor: pointer;
        font: inherit;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #0d1117; color: #e6edf3; }
        button { background: #1f6feb; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Can't reach your GitGood server</h1>
      <p>Check your connection, then try again.</p>
      <button type="button" onclick="location.reload()">Retry</button>
    </main>
  </body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('gitgood-assets-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || BYPASS_PATHS.has(url.pathname)) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
          // Hashed names change every release and are never requested again: keep only the newest few.
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)));
        }
        return response;
      }),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        () => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }),
      ),
    );
  }
});
