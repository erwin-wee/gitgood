import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { isInside } from '../main/repo/paths';

/** Reads the persisted bearer token, generating and storing a fresh 256-bit one on first run. */
export function loadOrCreateToken(tokenFile: string, dir: string): string {
  if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
  return token;
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extracts the presented bearer credential from either the Authorization header (`/invoke`) or a `token` query param (the `/events` WebSocket, which cannot set headers). */
export function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.searchParams.get('token');
}

export function tokenOk(req: IncomingMessage, token: string): boolean {
  const presented = presentedToken(req);
  return presented !== null && safeEqual(presented, token);
}

/**
 * Authorizes the Tailscale identity. `tailscale serve` always adds
 * `X-Forwarded-For` and, for a user-owned device, `Tailscale-User-Login`. A
 * request with neither is a direct loopback call (the desktop client, dev) and
 * passes; a forwarded one must carry exactly the allowed login, so tagged
 * devices (no login header) and other users are refused, and with no allowed
 * login configured nothing from the tailnet gets in.
 */
export function identityOk(req: IncomingMessage, allowedLogin: string | null): boolean {
  const login = req.headers['tailscale-user-login'];
  const forwarded = req.headers['x-forwarded-for'] !== undefined || login !== undefined;
  if (!forwarded) return true;
  return typeof login === 'string' && allowedLogin !== null && safeEqual(login, allowedLogin);
}

/**
 * DNS-rebinding guard: the server answers only to loopback names and its
 * tailnet name, so a web page whose own hostname resolves to 127.0.0.1 can
 * neither read the served token nor pass the same-origin check.
 */
export function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name.endsWith('.ts.net');
}

/**
 * Same-origin / CSRF guard. A cross-site page must not be able to drive the
 * backend, so a present `Origin` must match the request's own host. A missing
 * Origin (same-origin navigations, non-browser clients) is allowed.
 */
export function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Methods under `repo.`/`git.`/`gh.`/`ai.` whose first argument is not a repository path. */
const NO_REPO_ARG = /^(gh\.(auth|repos|orgs|inbox)\.|gh\.(gitignoreTemplates|licenses|avatar)$|ai\.(cancel|test)$)/;
/** Other methods whose first argument is a filesystem path. */
const FIRST_ARG_PATH = /^(repos\.(add|watchedFolders\.add|isInWatchedFolder|exclusions\.remove)|app\.(showItemInFolder|openPath|pathExists|isRepository|moveToTrash|openInEditor|openInShell)|settings\.(exportToFile|previewImport|import))$/;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

/**
 * The filesystem paths an invoke names, by method signature (`src/shared/ipc.ts`):
 * repository paths, path parameters and path fields of option objects. Content
 * arguments (file text, .gitignore lines, comments) are never paths, even when
 * they start with "/".
 *
 * ponytail: a hand-kept table of path positions; a new path-taking method must
 * be added here. Tool/editor executable paths in settings are not confined,
 * since /usr/bin is outside every root by design.
 */
export function pathArgs(method: string, args: unknown[]): unknown[] {
  const [first, second] = args;
  switch (method) {
    case 'repos.create':
    case 'repos.clone':
      return [field(first, 'directory')];
    case 'git.worktree.add':
      return [first, field(second, 'path')];
    case 'git.worktree.remove':
    case 'git.worktree.lock':
      return [first, second];
    case 'app.settings.set': {
      const folders = field(first, 'watchedFolders');
      return [field(first, 'defaultCloneDirectory'), ...(Array.isArray(folders) ? folders.map((f) => field(f, 'path')) : [])];
    }
  }
  if (/^(repo|git|gh|ai)\./.test(method) && !NO_REPO_ARG.test(method)) return [first];
  if (FIRST_ARG_PATH.test(method)) return [first];
  return [];
}

/**
 * Confines filesystem access to the allowlisted roots: each path from
 * `pathArgs` must be absolute and, once `..` is resolved, inside a root.
 * Null, undefined and '' mean "no path" (optional repository, unset field) and pass.
 * Returns the first offending value, or null.
 */
export function offendingPath(paths: unknown[], roots: string[]): string | null {
  for (const p of paths) {
    if (p === null || p === undefined || p === '') continue;
    if (typeof p !== 'string' || !isAbsolute(p)) return String(p);
    const target = resolve(p);
    if (!roots.some((root) => isInside(resolve(root), target))) return p;
  }
  return null;
}
