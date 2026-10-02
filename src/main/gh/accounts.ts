import type { GhAccountEntry } from '@shared/types';

interface RawJsonHost {
  state?: string;
  active?: boolean;
  host?: string;
  login?: string;
  scopes?: string;
  gitProtocol?: string;
}

const splitScopes = (s: string): string[] => s.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter((x) => x && x !== 'none');

/** gh 2.67+: `gh auth status --json hosts`. Only accounts whose token still works (`state: success`). */
function parseJson(text: string): GhAccountEntry[] {
  const parsed = JSON.parse(text) as { hosts?: Record<string, RawJsonHost[]> };
  const out: GhAccountEntry[] = [];
  for (const list of Object.values(parsed.hosts ?? {})) {
    for (const e of list) {
      if (e.state === 'success' && e.host && e.login) out.push({ host: e.host, login: e.login, active: !!e.active, scopes: splitScopes(e.scopes ?? ''), protocol: e.gitProtocol || null });
    }
  }
  return out;
}

/** Human output of gh 2.40+ (multi-account) and older single-account gh (`Logged in to host as login`). Failed logins are skipped. */
function parseText(text: string): GhAccountEntry[] {
  const out: GhAccountEntry[] = [];
  let current: GhAccountEntry | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const login = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line);
    if (login) {
      current = { host: login[1], login: login[2], active: false, scopes: [], protocol: null };
      out.push(current);
      continue;
    }
    if (/Failed to log in/i.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const active = /Active account:\s*(true|false)/i.exec(line);
    if (active) current.active = active[1].toLowerCase() === 'true';
    const protocol = /Git operations protocol:\s*(\S+)/i.exec(line);
    if (protocol) current.protocol = protocol[1];
    const scopes = /Token scopes:\s*(.*)$/i.exec(line);
    if (scopes) current.scopes = splitScopes(scopes[1]);
  }
  return out;
}

/**
 * Every signed-in account from `gh auth status` output (JSON or the human format; stdout and stderr
 * may be concatenated, older gh printed to stderr). Each host ends up with exactly one active entry
 * (the first, when gh did not say). Pure so it can be unit tested against canned output.
 */
export function parseGhAuthStatus(output: string): GhAccountEntry[] {
  const text = output.trim();
  const entries = text.startsWith('{') ? parseJson(text) : parseText(text);
  const hasActive = new Set(entries.filter((e) => e.active).map((e) => e.host));
  return entries.map((e) => (hasActive.has(e.host) || e.active ? e : (hasActive.add(e.host), { ...e, active: true })));
}

/** The account the app shows as "you": github.com's active account, else the first host's active one. */
export function primaryAccount(entries: GhAccountEntry[]): GhAccountEntry | null {
  const active = entries.filter((e) => e.active);
  return active.find((e) => e.host === 'github.com') ?? active[0] ?? null;
}

/** Environment that makes a `gh` run act as the account that owns `token` (gh reads github.com/GHE cloud tokens from GH_TOKEN, other hosts from GH_ENTERPRISE_TOKEN). */
export function ghAccountEnv(host: string, token: string): NodeJS.ProcessEnv {
  return { [host === 'github.com' || host.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN']: token };
}

/**
 * Environment that makes git's HTTPS operations against `host` authenticate with `token`: gh reads
 * it for its own credential helper, and an env-injected `credential.<url>.helper` (empty value first,
 * which drops every other configured helper) answers git directly, so it also wins over keychains.
 * Uses GIT_CONFIG_COUNT (Git 2.31+); older Git ignores it and falls back to the gh helper + GH_TOKEN.
 * `base` is the env the command will run with, so existing GIT_CONFIG_* pairs are kept.
 */
export function gitAccountEnv(host: string, token: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const n = Number.parseInt(base.GIT_CONFIG_COUNT ?? '', 10) || 0;
  const key = `credential.https://${host}.helper`;
  return {
    ...ghAccountEnv(host, token),
    GITGOOD_ACCOUNT_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: key,
    [`GIT_CONFIG_VALUE_${n + 1}`]: '!f() { echo username=x-access-token; echo "password=$GITGOOD_ACCOUNT_TOKEN"; }; f',
  };
}

/** git subcommands that talk to the remote and so need the repository's account token. */
export function isNetworkGitCommand(args: string[]): boolean {
  return /^(fetch|pull|push|clone|ls-remote|submodule|lfs)$/.test(args[0] ?? '');
}
