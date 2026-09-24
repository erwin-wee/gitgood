import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateToken } from './security';

/** Resolved server-mode configuration, read once at startup. */
export interface ServerConfig {
  /** Always loopback; `tailscale serve` is the only ingress. */
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Directory holding settings/repositories/secrets; desktop clients (`src/main/client.ts`) share it through the server, not the filesystem. */
  readonly userData: string;
  /** Directory of the built renderer (`out/renderer`) served as static assets. */
  readonly rendererDir: string;
  /** Bearer token gating `/invoke` and the `/events` upgrade. */
  readonly token: string;
  /** Whether the token was created on this start (so the caller prints it once). */
  readonly tokenCreated: boolean;
  /** Tailscale login allowed through `tailscale serve`: `GITGOOD_ALLOWED_LOGIN`, else this node's owner; null refuses every tailnet request. */
  readonly allowedLogin: string | null;
  /** Filesystem roots beyond registered repos + watched folders: the server user's home plus `GITGOOD_ALLOWED_ROOTS`. */
  readonly extraRoots: string[];
  readonly version: string;
}

function defaultRendererDir(): string {
  // The bundled server runs from out/server/index.mjs; the renderer sits at out/renderer.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
}

/** The login owning this tailnet node (`tailscale status --json`), or null when Tailscale is absent or the node is tagged. */
function tailnetOwner(): string | null {
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    return status.User?.[status.Self?.UserID]?.LoginName ?? null;
  } catch {
    return null;
  }
}

export function loadServerConfig(): ServerConfig {
  const userData = process.env.GITGOOD_USER_DATA || join(homedir(), '.config', 'gitgood-server');
  const tokenFile = join(userData, 'server-token');
  const existedBefore = existsSync(tokenFile);
  const token = loadOrCreateToken(tokenFile, userData);
  return {
    host: '127.0.0.1',
    port: Number(process.env.GITGOOD_SERVER_PORT) || 4600,
    userData,
    rendererDir: process.env.GITGOOD_RENDERER_DIR || defaultRendererDir(),
    token,
    tokenCreated: !existedBefore,
    allowedLogin: process.env.GITGOOD_ALLOWED_LOGIN || tailnetOwner(),
    // Home is browsable so the folder picker can add repos/watched folders that aren't registered yet.
    extraRoots: [homedir(), ...(process.env.GITGOOD_ALLOWED_ROOTS || '').split(delimiter).filter(Boolean)],
    version: process.env.GITGOOD_VERSION || (typeof __GITGOOD_VERSION__ === 'string' ? __GITGOOD_VERSION__ : '0.0.0'),
  };
}

/** Replaced with package.json's version by vite.server.config.ts; absent when run unbundled (tests). */
declare const __GITGOOD_VERSION__: string | undefined;
