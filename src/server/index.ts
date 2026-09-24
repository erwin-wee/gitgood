import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { brotliCompress, brotliCompressSync, constants as zlibConstants, gzip, gzipSync } from 'node:zlib';
import type { ApiMethodName } from '@shared/ipc';
import type { GitErrorInfo, InboxItem, IpcResult } from '@shared/types';
import { ConflictResolver } from '../main/ai/resolver';
import { ErrorExplainService } from '../main/ai/error-explain';
import { ExplainService } from '../main/ai/explain';
import { NlPaletteService } from '../main/ai/nlPalette';
import { PrDraftService } from '../main/ai/prDraft';
import { RebasePlanService } from '../main/ai/rebasePlan';
import { ReleaseNotesService } from '../main/ai/release-notes';
import { ReviewService } from '../main/ai/review';
import { SplitterService } from '../main/ai/splitter';
import { TriageService } from '../main/ai/triage';
import { EventBus } from '../main/core/bus';
import { clientContext } from '../main/core/client-context';
import { createHandlers, type HandlerDeps } from '../main/core/handlers';
import { GitClient } from '../main/git/git';
import { GhClient } from '../main/gh/gh';
import { shouldNotifyInboxItem } from '../main/gh/inbox';
import { InboxPoller } from '../main/gh/inbox-poller';
import { SettingsSyncService } from '../main/gh/settings-sync';
import { isInside } from '../main/repo/paths';
import { initLogger, log } from '../main/logger';
import { RepositoryManager } from '../main/repo/manager';
import { WatchedFolderScanner } from '../main/repo/watched-folders';
import { Store } from '../main/store';
import { ToolLocator } from '../main/tools';
import { GhCliReleaseProvider } from '../main/update/github-provider';
import { Updater } from '../main/update/updater';
import { auditLine, isMutating, KeyedMutex, locksRepo, mutationKey, RateLimiter } from './limits';
import { loadServerConfig, type ServerConfig } from './config';
import { hostOk, identityOk, offendingPath, originOk, pathArgs, tokenOk } from './security';
import { WebHost } from './web-host';
import { BRIDGE_TAG, bridgeScript } from './web-bridge';
import { WsHub } from './ws';

const RELEASES_URL = 'https://github.com/erwin-wee/gitgood/releases';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MIN_COMPRESS_BYTES = 1024;

type StaticAsset = {
  body: Buffer;
  etag: string;
  mtimeMs: number;
  brotli?: Buffer;
  gzip?: Buffer;
};

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
}

function errorResult(message: string, code: GitErrorInfo['code']): IpcResult<unknown> {
  return { ok: false, error: { message, command: '', exitCode: null, stderr: '', stdout: '', code } };
}

function assetEtag(body: Buffer): string {
  return '"' + createHash('sha1').update(body).digest('base64url') + '"';
}

function encodingQuality(header: string, encoding: 'br' | 'gzip'): number {
  let wildcard = 0;
  let explicit: number | undefined;
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    if (name !== encoding && name !== '*') continue;
    const q = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const quality = q ? Number(q.trim().slice(2)) : 1;
    if (name === encoding) explicit = quality;
    else wildcard = quality;
  }
  return explicit ?? wildcard;
}

function acceptedEncoding(req: IncomingMessage): 'br' | 'gzip' | null {
  const value = req.headers['accept-encoding'];
  const header = Array.isArray(value) ? value.join(',') : value ?? '';
  if (encodingQuality(header, 'br') > 0) return 'br';
  if (encodingQuality(header, 'gzip') > 0) return 'gzip';
  return null;
}

function matchesEtag(req: IncomingMessage, etag: string): boolean {
  const value = req.headers['if-none-match'];
  return typeof value === 'string' && value.split(',').some((candidate) => candidate.trim() === '*' || candidate.trim() === etag);
}

function compressible(filePath: string): boolean {
  return ['.js', '.mjs', '.css', '.html', '.json', '.webmanifest', '.svg', '.map'].includes(extname(filePath).toLowerCase());
}

function sendStatic(
  req: IncomingMessage,
  res: ServerResponse,
  asset: StaticAsset,
  filePath: string,
  contentType: string,
  cacheControl: string,
): void {
  const canCompress = asset.body.byteLength > MIN_COMPRESS_BYTES && compressible(filePath);
  const encoding = canCompress ? acceptedEncoding(req) : null;
  let body = asset.body;
  if (encoding === 'br') {
    asset.brotli ??= brotliCompressSync(asset.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } });
    body = asset.brotli;
  } else if (encoding === 'gzip') {
    asset.gzip ??= gzipSync(asset.body, { level: 9 });
    body = asset.gzip;
  }
  const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': cacheControl, ETag: asset.etag };
  if (canCompress) headers.Vary = 'Accept-Encoding';
  if (encoding) headers['Content-Encoding'] = encoding;
  if (matchesEtag(req, asset.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  headers['Content-Length'] = String(body.byteLength);
  res.writeHead(200, headers).end(body);
}

function compressInvokeBody(body: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
  return new Promise((resolveCompression, reject) => {
    if (encoding === 'br') {
      brotliCompress(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }, (error, compressed) => {
        if (error) reject(error);
        else resolveCompression(compressed);
      });
      return;
    }
    gzip(body, { level: 6 }, (error, compressed) => {
      if (error) reject(error);
      else resolveCompression(compressed);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve: done, reject } = Promise.withResolvers<string>();
  let size = 0;
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error('Request body too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
  return promise;
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  initLogger(join(config.userData, 'logs'));

  const store = new Store(config.userData);
  store.load();

  const tools = new ToolLocator(store);
  const git = new GitClient(tools);
  const gh = new GhClient(tools);
  const bus = new EventBus();
  const host = new WebHost(config.version, config.userData);
  const busy = new Set<string>();

  const repos = new RepositoryManager(store, git, bus.emit);
  const resolver = new ConflictResolver(store, tools, git);
  const review = new ReviewService(store, tools, git, gh, repos, config.userData);
  const splitter = new SplitterService(store, tools, git);
  const triage = new TriageService(store, tools, gh, repos, config.userData);
  const prDraft = new PrDraftService(store, tools, git, gh, repos);
  const rebasePlan = new RebasePlanService(store, tools, git);
  const releaseNotes = new ReleaseNotesService(store, tools, git, gh, repos);
  const explain = new ExplainService(store, tools, git);
  const errorExplain = new ErrorExplainService(store, tools, git);
  const nlPalette = new NlPaletteService(store, tools, git);
  // Pre-filtered by the notification settings so a desktop client only has to check its own window focus.
  const onNewInboxItems = (items: InboxItem[]) => {
    const notify = items.filter((item) => shouldNotifyInboxItem(item, store.getSettings()));
    if (notify.length) bus.emit('gh.inbox.new', notify);
  };
  const inbox = new InboxPoller(store, gh, (state) => bus.emit('gh.inbox.changed', state), onNewInboxItems, {
    listLocalRepos: () => store.getRepositories().map((r) => ({ id: r.id, github: r.github })),
    getAccount: () => tools.current().ghAccount,
  });
  const settingsSync = new SettingsSyncService(store, gh, repos);
  const watchedFolders = new WatchedFolderScanner(store, repos, bus.emit);
  // Updates never apply to a headless server: an unpackaged disabledEnv reports "disabled",
  // so the provider is never called and app.update.* handlers report the disabled state.
  const updater = new Updater(store, new GhCliReleaseProvider(gh), (state) => bus.emit('app.update.changed', state), {
    getVersion: () => config.version,
    manualUrl: RELEASES_URL,
    disabledEnv: { isPackaged: false, platform: process.platform, portableExecutableDir: undefined, appImagePath: undefined, appImageWritable: false },
  });

  const deps: HandlerDeps = { store, tools, git, gh, repos, resolver, review, splitter, triage, prDraft, rebasePlan, releaseNotes, explain, errorExplain, inbox, settingsSync, updater, nlPalette, watchedFolders, host, emit: bus.emit, busy };
  const { dispatch } = createHandlers(deps);

  store.onSettingsChanged((settings) => bus.emit('settings.changed', settings));

  const wsHub = new WsHub();
  const mutex = new KeyedMutex();
  // Revalidated by mtime so a rebuild under a running server (git-checkout installs) is picked up without a restart.
  const staticCache = new Map<string, StaticAsset>();
  const getStaticAsset = (filePath: string, injectBridge = false): StaticAsset => {
    const key = injectBridge ? filePath + ':injected' : filePath;
    const cached = staticCache.get(key);
    const { mtimeMs } = statSync(filePath);
    if (cached?.mtimeMs === mtimeMs) return cached;
    let body = readFileSync(filePath);
    if (injectBridge) body = Buffer.from(body.toString('utf8').replace('</head>', BRIDGE_TAG + '</head>'));
    const asset = { body, etag: assetEtag(body), mtimeMs };
    staticCache.set(key, asset);
    return asset;
  };
  // Generous per-client budget: a UI burst is fine, a runaway loop is not.
  const limiter = new RateLimiter(120, 20);
  bus.subscribe((event, payload) => wsHub.broadcast(JSON.stringify({ event, payload })));

  const allowedRoots = (): string[] => {
    const settings = store.getSettings();
    return [
      ...store.getRepositories().map((r) => r.path),
      ...settings.watchedFolders.map((f) => f.path),
      ...(settings.defaultCloneDirectory ? [settings.defaultCloneDirectory] : []),
      ...config.extraRoots,
    ];
  };

  const listDir = (requested: string | null): IpcResult<unknown> => {
    const roots = allowedRoots();
    if (!requested) {
      // Top level lists only outermost roots: repos inside a watched folder or home are reached by browsing.
      const unique = [...new Set(roots)].filter((p) => existsSync(p));
      const entries = unique.filter((p) => !unique.some((q) => isInside(q, p) && !isInside(p, q))).map((p) => ({ name: p, path: p }));
      return { ok: true, value: { path: null, parent: null, entries } };
    }
    const expanded = requested.replace(/^~(?=\/|$)/, homedir());
    if (!isAbsolute(expanded)) return errorResult(`Enter an absolute path (or one starting with ~).`, 'unsupported');
    const target = resolve(expanded);
    if (offendingPath([target], roots)) return errorResult(`Path "${target}" is outside the allowed locations (your home, registered repositories, watched folders, GITGOOD_ALLOWED_ROOTS).`, 'unsupported');
    try {
      const entries = readdirSync(target, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: join(target, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = dirname(target);
      const parentAllowed = parent !== target && !offendingPath([parent], roots);
      return { ok: true, value: { path: target, parent: parentAllowed ? parent : null, entries } };
    } catch (err) {
      return errorResult(`Could not read "${target}": ${(err as Error).message}`, 'unknown');
    }
  };

  const runInvoke = async (method: string, args: unknown[], clientId: string): Promise<IpcResult<unknown>> => {
    if (method === 'app.listDir') return listDir(typeof args[0] === 'string' ? args[0] : null);
    const bad = offendingPath(pathArgs(method, args), allowedRoots());
    if (bad) return errorResult(`Path "${bad}" is outside the allowed locations.`, 'unsupported');
    // Per-client state (open repository watcher, in-flight history load) is keyed by this context.
    const run = () => clientContext.run(clientId, () => dispatch(method as ApiMethodName, args));
    if (!isMutating(method)) return run();
    const key = mutationKey(method, args);
    // Concurrent mutations to the same repo are serialized so multiple clients can't race git's index/locks.
    const result = locksRepo(method) ? await mutex.run(key, run) : await run();
    log.info(auditLine(clientId, method, key, result.ok));
    return result;
  };

  const serveInvoke = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!originOk(req)) return fail(res, 403, 'Cross-origin request rejected.');
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) return fail(res, 415, 'Content-Type must be application/json.');
    if (!tokenOk(req, config.token)) return fail(res, 401, 'Missing or invalid token.');
    // Keyed by where the request came from, never a caller-chosen label: tailscale serve sets X-Forwarded-For (the
    // device's tailnet address); direct loopback callers (the desktop client, local tools) share one budget.
    const forwardedFor = req.headers['x-forwarded-for'];
    const rateKey = (typeof forwardedFor === 'string' && forwardedFor) || req.socket.remoteAddress || 'anon';
    if (!limiter.allow(rateKey)) return fail(res, 429, 'Too many requests.');
    let parsed: { method?: unknown; args?: unknown };
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return fail(res, 400, 'Invalid JSON body.');
    }
    if (typeof parsed.method !== 'string') return fail(res, 400, 'Missing "method".');
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    const clientId = typeof req.headers['x-gitgood-client'] === 'string' ? req.headers['x-gitgood-client'] : '';
    const result = await runInvoke(parsed.method, args, clientId);
    const uncompressed = Buffer.from(JSON.stringify(result));
    const canCompress = uncompressed.byteLength > MIN_COMPRESS_BYTES;
    const encoding = canCompress ? acceptedEncoding(req) : null;
    const body = encoding ? await compressInvokeBody(uncompressed, encoding) : uncompressed;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.byteLength),
    };
    if (canCompress) headers.Vary = 'Accept-Encoding';
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers).end(body);
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/gitgood-bridge.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(bridgeScript(config.token, process.platform));
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return fail(res, 400, 'Malformed URL.');
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const filePath = resolve(config.rendererDir, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
    // SPA fallback: any non-asset route (and "/") serves the injected index.html.
    if (!filePath.startsWith(resolve(config.rendererDir)) || !existsSync(filePath) || !extname(filePath)) {
      serveIndex(req, res);
      return;
    }
    const contentType = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const cacheControl = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    sendStatic(req, res, getStaticAsset(filePath), filePath, contentType, cacheControl);
  };

  const serveIndex = (req: IncomingMessage, res: ServerResponse): void => {
    const indexPath = join(config.rendererDir, 'index.html');
    if (!existsSync(indexPath)) {
      fail(res, 500, 'Renderer build not found. Run "npm run build" first.');
      return;
    }
    sendStatic(req, res, getStaticAsset(indexPath, true), indexPath, 'text/html; charset=utf-8', 'no-cache');
  };

  const server = createServer((req, res) => {
    // Every route, static ones included: /gitgood-bridge.js hands out the token.
    if (!hostOk(req)) return fail(res, 421, 'Unknown host.');
    if (!identityOk(req, config.allowedLogin)) return fail(res, 403, 'Tailscale identity not allowed.');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ version: config.version }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/invoke') {
      void serveInvoke(req, res).catch((err) => fail(res, 500, `Server error: ${(err as Error).message}`));
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    fail(res, 405, 'Method not allowed.');
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/events' || !hostOk(req) || !originOk(req) || !tokenOk(req, config.token) || !identityOk(req, config.allowedLogin)) {
      socket.destroy();
      return;
    }
    const clientId = url.searchParams.get('client') ?? '';
    wsHub.accept(req, socket, clientId, () => {
      // A page reconnects within seconds after a network blip; only a client gone for good gives up its watcher.
      setTimeout(() => {
        if (!wsHub.has(clientId)) repos.releaseClient(clientId);
      }, 60_000).unref();
    });
  });

  // A failed bind (e.g. EADDRINUSE) must kill the process, not leave a live-but-deaf server behind.
  server.on('error', (err) => {
    log.error('Server failed', err);
    process.exit(1);
  });

  inbox.onFocus();
  inbox.start();
  watchedFolders.watchSettings();
  void tools.refresh().then((state) => {
    log.info(`git: ${state.git.version ?? 'missing'}; gh: ${state.gh.version ?? 'missing'}; account: ${state.ghAccount?.login ?? 'none'}`);
    bus.emit('tools.changed', state);
    if (store.getSettings().watchedFolders.length) void watchedFolders.scan().catch((err) => log.error('Watched-folder scan failed', err));
  });

  server.listen(config.port, config.host, () => {
    log.info(`GitGood server ${config.version} listening on http://${config.host}:${config.port}`);
    log.info(`Expose it on your tailnet with: tailscale serve --bg ${config.port}`);
    if (config.tokenCreated) log.info(`Access token (shown once): ${config.token}`);
    else log.info(`Access token stored at ${join(config.userData, 'server-token')}`);
    if (config.allowedLogin) log.info(`Tailnet access allowed for ${config.allowedLogin}`);
    else log.warn('No Tailscale login to allow (set GITGOOD_ALLOWED_LOGIN): requests through tailscale serve are refused.');
  });

  const shutdown = (): void => {
    log.info('Shutting down GitGood server');
    wsHub.closeAll();
    inbox.dispose();
    updater.dispose();
    repos.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // State after an uncaught exception is unknown: log it and let systemd (Restart=on-failure) start a clean process.
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));
}

void main();
