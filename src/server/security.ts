import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute } from 'node:path';
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

/**
 * Confines filesystem access to the allowlisted roots. Every absolute-path
 * string argument to an invoke must resolve inside a registered repository or
 * an allowed root; anything else (an unregistered repo path, a scan/enumeration
 * escape) is rejected before the handler runs. Relative arguments (branch
 * names, SHAs, messages, repo-relative file paths) pass through untouched.
 *
 * ponytail: absolute-arg scan, not per-method schemas. If a legitimate absolute
 * arg outside every root ever needs through, gate that method by name instead.
 */
export function offendingPath(args: unknown[], roots: string[]): string | null {
  for (const arg of args) {
    if (typeof arg !== 'string' || !isAbsolute(arg)) continue;
    if (!roots.some((root) => isInside(root, arg))) return arg;
  }
  return null;
}
