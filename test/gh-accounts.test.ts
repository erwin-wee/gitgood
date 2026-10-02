import { describe, expect, it } from 'vitest';
import { ghAccountEnv, gitAccountEnv, isNetworkGitCommand, parseGhAuthStatus, primaryAccount } from '../src/main/gh/accounts';

const ONE_ACCOUNT_TEXT = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`;

const TWO_ACCOUNTS_TEXT = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account work-bot (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'repo'
`;

const TWO_ACCOUNTS_JSON = JSON.stringify({
  hosts: {
    'github.com': [
      { state: 'success', active: true, host: 'github.com', login: 'octocat', tokenSource: 'keyring', scopes: 'gist, read:org, repo', gitProtocol: 'https' },
      { state: 'success', active: false, host: 'github.com', login: 'work-bot', tokenSource: 'keyring', scopes: 'repo', gitProtocol: 'ssh' },
      { state: 'error', active: false, host: 'github.com', login: 'stale', tokenSource: 'keyring', scopes: '', gitProtocol: 'https' },
    ],
  },
});

describe('parseGhAuthStatus', () => {
  it('reads one account from the human-readable output', () => {
    expect(parseGhAuthStatus(ONE_ACCOUNT_TEXT)).toEqual([{ host: 'github.com', login: 'octocat', active: true, scopes: ['gist', 'read:org', 'repo', 'workflow'], protocol: 'https' }]);
  });

  it('reads two accounts on one host and which one is active', () => {
    const accounts = parseGhAuthStatus(TWO_ACCOUNTS_TEXT);
    expect(accounts.map((a) => [a.login, a.active, a.protocol])).toEqual([
      ['octocat', false, 'https'],
      ['work-bot', true, 'ssh'],
    ]);
    expect(primaryAccount(accounts)?.login).toBe('work-bot');
  });

  it('reads the JSON form, skipping accounts whose token no longer works', () => {
    const accounts = parseGhAuthStatus(TWO_ACCOUNTS_JSON);
    expect(accounts.map((a) => [a.login, a.active, a.scopes])).toEqual([
      ['octocat', true, ['gist', 'read:org', 'repo']],
      ['work-bot', false, ['repo']],
    ]);
  });

  it('accepts pre-multi-account gh output and marks a lone account active', () => {
    expect(parseGhAuthStatus('github.com\n  ✓ Logged in to github.com as octocat (keyring)\n  ✓ Git operations for github.com configured to use https protocol.\n')).toEqual([
      { host: 'github.com', login: 'octocat', active: true, scopes: [], protocol: null },
    ]);
  });

  it('ignores failed logins and returns nothing when signed out', () => {
    const failed = 'github.com\n  X Failed to log in to github.com account octocat (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n';
    expect(parseGhAuthStatus(failed)).toEqual([]);
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual([]);
  });

  it('keeps each host\u2019s own active account and prefers github.com as primary', () => {
    const out = `ghe.example.com\n  ✓ Logged in to ghe.example.com account corp (keyring)\n  - Active account: true\ngithub.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n`;
    const accounts = parseGhAuthStatus(out);
    expect(accounts.filter((a) => a.active)).toHaveLength(2);
    expect(primaryAccount(accounts)?.host).toBe('github.com');
  });
});

describe('account environment', () => {
  it('uses GH_TOKEN for github.com and GH_ENTERPRISE_TOKEN for other hosts', () => {
    expect(ghAccountEnv('github.com', 't')).toEqual({ GH_TOKEN: 't' });
    expect(ghAccountEnv('ghe.example.com', 't')).toEqual({ GH_ENTERPRISE_TOKEN: 't' });
  });

  it('appends its credential helper after GIT_CONFIG pairs already in the environment', () => {
    const env = gitAccountEnv('github.com', 'tok', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' });
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toBe('');
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_2).toContain('GITGOOD_ACCOUNT_TOKEN');
    expect(env.GITGOOD_ACCOUNT_TOKEN).toBe('tok');
  });

  it('treats only remote-talking git subcommands as network commands', () => {
    for (const cmd of ['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule', 'lfs']) expect(isNetworkGitCommand([cmd])).toBe(true);
    for (const cmd of ['status', 'log', 'commit', 'remote']) expect(isNetworkGitCommand([cmd])).toBe(false);
  });
});
