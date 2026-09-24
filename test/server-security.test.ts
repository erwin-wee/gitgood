import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { hostOk, identityOk, loadOrCreateToken, offendingPath, originOk, pathArgs, safeEqual, tokenOk } from '../src/server/security';

function req(headers: Record<string, string>, url = '/invoke'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

const root = `${sep}repos${sep}app`;

describe('offendingPath (path confinement)', () => {
  it('allows an absolute path inside an allowed root, and the root itself', () => {
    expect(offendingPath([`${root}${sep}src${sep}a.ts`, root], [root])).toBeNull();
  });

  it('rejects an absolute path outside every root', () => {
    expect(offendingPath([`${sep}etc${sep}passwd`], [root])).toBe(`${sep}etc${sep}passwd`);
  });

  it('rejects a sibling that merely shares a prefix', () => {
    expect(offendingPath([`${sep}repos${sep}app-evil`], [root])).toBe(`${sep}repos${sep}app-evil`);
  });

  it('rejects ".." climbing out of a root', () => {
    const escape = `${root}${sep}..${sep}..${sep}etc`;
    expect(offendingPath([escape], [root])).toBe(escape);
  });

  it('rejects a relative path, which would resolve against the server working directory', () => {
    expect(offendingPath(['..'], [root])).toBe('..');
  });

  it('treats null, undefined and empty as no path', () => {
    expect(offendingPath([null, undefined, ''], [root])).toBeNull();
  });
});

describe('pathArgs', () => {
  it('finds paths inside option objects', () => {
    expect(pathArgs('repos.create', [{ name: 'x', directory: '/tmp' }])).toEqual(['/tmp']);
    expect(pathArgs('repos.clone', [{ url: 'u', directory: '/tmp', branch: null }])).toEqual(['/tmp']);
    expect(pathArgs('git.worktree.add', ['/repos/app', { path: '/tmp/wt' }])).toEqual(['/repos/app', '/tmp/wt']);
    expect(pathArgs('app.settings.set', [{ defaultCloneDirectory: '/tmp', watchedFolders: [{ path: '/srv' }] }])).toEqual(['/tmp', '/srv']);
  });

  it('never treats content arguments as paths, even when they start with "/"', () => {
    expect(pathArgs('repo.writeFile', ['/repos/app', 'a.c', '// header\n'])).toEqual(['/repos/app']);
    expect(pathArgs('repo.gitignore.write', ['/repos/app', '/node_modules\n'])).toEqual(['/repos/app']);
    expect(pathArgs('gh.pr.comment', ['/repos/app', 1, '/approve'])).toEqual(['/repos/app']);
  });

  it('skips methods whose first argument is not a repository', () => {
    expect(pathArgs('gh.auth.login', ['github.com'])).toEqual([]);
    expect(pathArgs('gh.avatar', ['me@example.com'])).toEqual([]);
    expect(pathArgs('repos.remove', ['abc123', true])).toEqual([]);
  });
});

describe('auth guards', () => {
  it('accepts the bearer token from the Authorization header', () => {
    expect(tokenOk(req({ authorization: 'Bearer secret' }), 'secret')).toBe(true);
    expect(tokenOk(req({ authorization: 'Bearer wrong' }), 'secret')).toBe(false);
    expect(tokenOk(req({}), 'secret')).toBe(false);
  });

  it('accepts the token from the query string (WebSocket upgrade)', () => {
    expect(tokenOk(req({}, '/events?token=secret'), 'secret')).toBe(true);
  });

  it('safeEqual is false on length mismatch and value mismatch', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('lets direct loopback calls through and holds forwarded ones to the allowed login', () => {
    expect(identityOk(req({}), 'me@example.com')).toBe(true); // no forwarding headers → loopback, token-only
    expect(identityOk(req({ 'x-forwarded-for': '100.64.0.1', 'tailscale-user-login': 'me@example.com' }), 'me@example.com')).toBe(true);
    expect(identityOk(req({ 'x-forwarded-for': '100.64.0.1', 'tailscale-user-login': 'evil@example.com' }), 'me@example.com')).toBe(false);
    expect(identityOk(req({ 'x-forwarded-for': '100.64.0.1' }), 'me@example.com')).toBe(false); // tagged device: no login header
    expect(identityOk(req({ 'x-forwarded-for': '100.64.0.1', 'tailscale-user-login': 'me@example.com' }), null)).toBe(false);
  });

  it('answers only to loopback and tailnet host names (DNS rebinding)', () => {
    expect(hostOk(req({ host: '127.0.0.1:4600' }))).toBe(true);
    expect(hostOk(req({ host: 'localhost:4600' }))).toBe(true);
    expect(hostOk(req({ host: 'gg.tail1234.ts.net' }))).toBe(true);
    expect(hostOk(req({ host: 'evil.example:4600' }))).toBe(false);
    expect(hostOk(req({ host: 'ts.net.evil.example' }))).toBe(false);
    expect(hostOk(req({}))).toBe(false);
  });

  it('rejects a cross-origin request, allows same-origin and header-less', () => {
    expect(originOk(req({ host: 'gg.ts.net', origin: 'https://gg.ts.net' }))).toBe(true);
    expect(originOk(req({ host: 'gg.ts.net', origin: 'https://evil.example' }))).toBe(false);
    expect(originOk(req({ host: 'gg.ts.net' }))).toBe(true);
  });
});

describe('token persistence', () => {
  it('generates a token once and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-token-'));
    const file = join(dir, 'server-token');
    const first = loadOrCreateToken(file, dir);
    expect(existsSync(file)).toBe(true);
    expect(first).toHaveLength(64); // 32 bytes hex
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(loadOrCreateToken(file, dir)).toBe(first);
  });
});
