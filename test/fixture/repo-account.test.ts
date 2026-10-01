import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoScope } from '../../src/main/core/client-context';
import { gitAccountEnv } from '../../src/main/gh/accounts';
import { GhClient } from '../../src/main/gh/gh';
import { GitClient } from '../../src/main/git/git';
import type { Store } from '../../src/main/store';
import { ToolLocator } from '../../src/main/tools';
import { DEFAULT_SETTINGS, type AppSettings, type RepositoryInfo } from '../../src/shared/types';

// Stub tools are POSIX shell scripts.
const posix = process.platform !== 'win32';

let dir: string;
let work: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gitgood-account-'));
  work = join(dir, 'work');
  await mkdir(work);
  vi.stubEnv('SHELL', '/bin/sh'); // a fast login shell for the shared PATH lookup
  vi.stubEnv('GH_TOKEN', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function stub(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function locator(settings: Partial<AppSettings>, repositories: Partial<RepositoryInfo>[] = []): ToolLocator {
  const full = { ...DEFAULT_SETTINGS, ...settings, ai: { ...DEFAULT_SETTINGS.ai, ...(settings.ai ?? {}) } };
  return new ToolLocator({ getSettings: () => full, getRepositories: () => repositories as RepositoryInfo[] } as unknown as Store);
}

describe.skipIf(!posix)('tool probes', () => {
  it('lets git run while a slow claude probe is still running, then reports claude when it finishes', async () => {
    const git = await stub('git', 'echo "git version 2.45.0"');
    const claude = await stub('claude', 'if [ "$1" = "--version" ]; then sleep 2; echo "1.2.3 (Claude Code)"; fi');
    const tools = locator({ gitPath: git, ai: { claudeCliPath: claude } as AppSettings['ai'] });
    const changes: string[] = [];
    tools.onChange((s) => changes.push(s.claudeCli.pending ? 'claude-pending' : 'claude-done'));

    const started = Date.now();
    const out = await new GitClient(tools).run(dir, ['version']);
    const elapsed = Date.now() - started;

    expect(out.stdout).toContain('git version');
    expect(elapsed).toBeLessThan(1500);
    expect(tools.current().claudeCli.pending).toBe(true);

    await tools.ensure('claudeCli');
    expect(tools.current().claudeCli).toMatchObject({ installed: true, version: '1.2.3 (Claude Code)' });
    expect(changes.at(-1)).toBe('claude-done');
  });
});

describe.skipIf(!posix)('repository GitHub account', () => {
  const REPO_ACCOUNT = { host: 'github.com', login: 'work-bot' };

  async function setup(repositories: 'chosen' | 'none') {
    const envLog = join(dir, 'env.log');
    const tokenCalls = join(dir, 'token-calls.log');
    // git/gh stubs dump the env vars the account feature sets, one block per run, and record `gh auth token` calls.
    const dump = `{ echo "ARGV=$*"; echo "GH_TOKEN=$GH_TOKEN"; echo "COUNT=$GIT_CONFIG_COUNT"; echo "HELPER_TOKEN=$GITGOOD_ACCOUNT_TOKEN"; } >> "${envLog}"`;
    const git = await stub('git', `case "$*" in *--version*) echo "git version 2.45.0";; *) ${dump};; esac`);
    const gh = await stub('gh', `case "$*" in *--version*) echo "gh version 2.101.0";; "auth token --hostname github.com --user work-bot") echo x >> "${tokenCalls}"; echo "tok_work";; *) ${dump};; esac`);
    const repo: Partial<RepositoryInfo> = { path: work, ...(repositories === 'chosen' ? { githubAccount: REPO_ACCOUNT } : {}) };
    const tools = locator({ gitPath: git, ghPath: gh }, [repo]);
    return { tools, envLog, tokenCalls };
  }

  const blocks = async (file: string) => (await readFile(file, 'utf8')).trim().split(/(?=ARGV=)/);

  it('fetches the token once and injects it into push and fetch, but not into local commands', async () => {
    const { tools, envLog, tokenCalls } = await setup('chosen');
    const git = new GitClient(tools);
    await git.run(work, ['push', 'origin', 'main']).catch(() => undefined);
    await git.run(work, ['fetch', '--prune']);
    await git.run(work, ['push', 'origin', 'main']);
    await git.run(work, ['status']);

    const runs = (await blocks(envLog)).map((b) => ({ argv: /ARGV=(.*)/.exec(b)![1], token: /GH_TOKEN=(.*)/.exec(b)![1], count: /COUNT=(.*)/.exec(b)![1] }));
    const network = runs.filter((r) => /--no-pager (push|fetch)/.test(r.argv));
    expect(network).toHaveLength(3);
    for (const r of network) expect(r).toMatchObject({ token: 'tok_work', count: '2' });
    expect(runs.find((r) => r.argv.endsWith('status'))).toMatchObject({ token: '', count: '' });
    expect((await readFile(tokenCalls, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('does not touch a repository that follows the active account', async () => {
    const { tools, envLog } = await setup('none');
    await new GitClient(tools).run(work, ['push']);
    expect(await readFile(envLog, 'utf8')).toContain('GH_TOKEN=\n');
  });

  it('runs gh as the repository account for its cwd and for a handler scoped to the repository', async () => {
    const { tools, envLog } = await setup('chosen');
    const gh = new GhClient(tools);
    await gh.run(['repo', 'view'], { cwd: work }).catch(() => undefined);
    await repoScope.run(work, () => gh.run(['pr', 'list']));
    await gh.run(['gist', 'list']); // no repository in play: the active account
    const runs = (await blocks(envLog)).map((b) => ({ argv: /ARGV=(.*)/.exec(b)![1], token: /GH_TOKEN=(.*)/.exec(b)![1] }));
    expect(runs.find((r) => r.argv.startsWith('pr list'))?.token).toBe('tok_work');
    expect(runs.find((r) => r.argv.startsWith('gist list'))?.token).toBe('');
  });

  it('refuses to fall back to another identity when the chosen account is no longer signed in', async () => {
    const git = await stub('git', 'echo "git version 2.45.0"');
    const gh = await stub('gh', 'case "$*" in *--version*) echo "gh version 2.101.0";; *) echo "no token found" >&2; exit 1;; esac');
    const tools = locator({ gitPath: git, ghPath: gh }, [{ path: work, githubAccount: REPO_ACCOUNT }]);
    await expect(new GitClient(tools).run(work, ['push'])).rejects.toMatchObject({ info: { code: 'gh-not-authenticated' } });
  });
});

describe('credential helper env', () => {
  it('makes git itself answer credential requests for the host with the account token', () => {
    let out: string;
    try {
      out = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        env: { ...process.env, ...gitAccountEnv('github.com', 'tok_abc', process.env), GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
      });
    } catch (err) {
      // Git older than 2.31 ignores GIT_CONFIG_COUNT and falls back to the gh helper; nothing to assert there.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      const version = /git version (\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
      if (version && (Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 31))) return;
      throw err;
    }
    expect(out).toContain('username=x-access-token');
    expect(out).toContain('password=tok_abc');
  });
});
