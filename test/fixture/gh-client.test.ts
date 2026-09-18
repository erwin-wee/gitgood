import { afterEach, describe, expect, it } from 'vitest';
import { GhClient } from '../../src/main/gh/gh';
import { GitError } from '../../src/main/git/git';
import type { GitHubRepoRef } from '../../src/shared/types';
import { createFakeTools } from '../helpers/fake-tools';
import { createStubScenario, ghLauncherPath, readStubLog, type StubScenario } from '../helpers/gh-stub';

const REF: GitHubRepoRef = { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' };

async function withScenario(rules: Parameters<typeof createStubScenario>[0], fn: (client: GhClient, scenario: StubScenario) => Promise<void>): Promise<void> {
  const scenario = await createStubScenario(rules);
  try {
    const tools = createFakeTools({ ghPath: ghLauncherPath(), env: scenario.env('GH') });
    const client = new GhClient(tools);
    await fn(client, scenario);
  } finally {
    await scenario.dispose();
  }
}

describe('GhClient against the gh stub', () => {
  it('account() reads the cached ghAccount from tools', async () => {
    const tools = createFakeTools({ ghPath: ghLauncherPath(), ghAccount: { login: 'octocat', name: 'The Octocat', avatarUrl: null, host: 'github.com', scopes: ['repo'], protocol: 'https' } });
    const client = new GhClient(tools);
    const account = await client.account();
    expect(account?.login).toBe('octocat');
  });

  it('prList maps raw PR JSON, including checks summary', async () => {
    const raw = [
      {
        number: 12,
        title: 'Add feature',
        url: 'https://github.com/octo/repo/pull/12',
        author: { login: 'octocat' },
        headRefName: 'feature',
        baseRefName: 'main',
        headRefOid: 'abc123',
        state: 'OPEN',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        isDraft: false,
        labels: [{ name: 'bug' }],
      },
    ];
    await withScenario([{ match: ['pr', 'list', '--repo', 'octo/repo'], stdout: JSON.stringify(raw) }], async (client) => {
      const prs = await client.prList(REF, 'open');
      expect(prs).toHaveLength(1);
      expect(prs[0]).toMatchObject({ number: 12, title: 'Add feature', headRefName: 'feature', headSha: 'abc123', checks: { total: 1, passed: 1, state: 'success' }, labels: ['bug'] });
    });
  });

  it('prView maps a single pull request', async () => {
    const raw = { number: 7, title: 'Fix bug', url: 'https://github.com/octo/repo/pull/7', headRefName: 'fix', baseRefName: 'main', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await withScenario([{ match: ['pr', 'view', '7'], stdout: JSON.stringify(raw) }], async (client) => {
      const pr = await client.prView(REF, 7);
      expect(pr).toMatchObject({ number: 7, title: 'Fix bug', author: 'unknown' });
    });
  });

  it('prChecks maps check runs', async () => {
    const raw = [{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://x', workflow: 'CI', description: '', startedAt: '', completedAt: '' }];
    await withScenario([{ match: ['pr', 'checks', '9'], stdout: JSON.stringify(raw) }], async (client) => {
      const checks = await client.prChecks(REF, 9);
      expect(checks).toEqual([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://x', workflow: 'CI', description: '', startedAt: null, completedAt: null }]);
    });
  });

  it('prCreate sends the expected argument shape and returns the created URL', async () => {
    await withScenario([{ match: ['pr', 'create'], stdout: 'https://github.com/octo/repo/pull/42\n' }], async (client, scenario) => {
      const result = await client.prCreate(process.cwd(), { base: 'main', head: 'feature', title: 'My PR', body: 'Body text', draft: true, web: false });
      expect(result.url).toBe('https://github.com/octo/repo/pull/42');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['pr', 'create', '--base', 'main', '--head', 'feature', '--title', 'My PR', '--body-file', '-', '--draft']);
    });
  });

  it('parses the device code and URL out of the login flow output', async () => {
    await withScenario(
      [
        { match: ['auth', 'login'], stderr: '! First copy your one-time code: WDJB-MJHT\nPress Enter to open https://github.com/login/device in your browser...\n' },
        { match: ['auth', 'setup-git'], stdout: '' },
      ],
      async (client) => {
        let code: string | null = null;
        let url: string | null = null;
        const result = await client.login('github.com', (c, u) => {
          code = c;
          url = u;
        });
        expect(result.ok).toBe(true);
        expect(code).toBe('WDJB-MJHT');
        expect(url).toBe('https://github.com/login/device');
      },
    );
  });

  it('classifies a 401 response as gh-not-authenticated', async () => {
    await withScenario([{ match: ['repo', 'view'], stderr: 'HTTP 401: Bad credentials', exitCode: 1 }], async (client) => {
      await expect(client.run(['repo', 'view'])).rejects.toMatchObject({ info: { code: 'gh-not-authenticated' } });
    });
  });

  it('preserves rate-limit error text for the user even though it has no dedicated code', async () => {
    await withScenario([{ match: ['repo', 'view'], stderr: 'HTTP 403: API rate limit exceeded for installation ID 123.', exitCode: 1 }], async (client) => {
      try {
        await client.run(['repo', 'view']);
        throw new Error('expected client.run to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(GitError);
        expect((err as GitError).info.message).toContain('API rate limit exceeded');
      }
    });
  });

  it('classifies a 403 rate-limit response and extracts the reset time', async () => {
    await withScenario([{ match: ['issue', 'list'], stderr: 'HTTP 403: API rate limit exceeded for user ID 123. Rate limit will reset at 2026-09-17T15:00:00Z.', exitCode: 1 }], async (client) => {
      await expect(client.run(['issue', 'list'])).rejects.toMatchObject({ info: { code: 'rate-limited', rateLimitResetAt: '2026-09-17T15:00:00.000Z' } });
    });
  });

  it('classifies a secondary rate limit without an explicit reset time', async () => {
    await withScenario([{ match: ['issue', 'create'], stderr: 'you have exceeded a secondary rate limit, please wait a moment', exitCode: 1 }], async (client) => {
      await expect(client.run(['issue', 'create'])).rejects.toMatchObject({ info: { code: 'rate-limited', rateLimitResetAt: null } });
    });
  });

  it('issueList builds the expected gh issue list arguments from a filter', async () => {
    await withScenario([{ match: ['issue', 'list'], stdout: '[]' }], async (client, scenario) => {
      await client.issueList('octo/repo', { search: 'timeout', state: 'open', assignee: 'me', author: 'any', mentioned: true, labels: ['bug', 'p1'], milestone: 'v1' });
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual([
        'issue', 'list', '--repo', 'octo/repo', '--state', 'open', '--limit', '100',
        '--search', 'timeout sort:updated-desc',
        '--assignee', '@me', '--mention', '@me', '--label', 'bug,p1', '--milestone', 'v1',
        '--json', 'number,title,url,state,author,labels,assignees,milestone,createdAt,updatedAt,comments,body',
      ]);
    });
  });

  it('issueList maps raw JSON into Issue objects, including a comments count', async () => {
    const raw = [{ number: 5, title: 'Bug', url: 'https://github.com/octo/repo/issues/5', state: 'OPEN', author: { login: 'octocat' }, labels: [{ name: 'bug', color: 'ff0000' }], assignees: [{ login: 'octocat' }], milestone: { title: 'v1' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', comments: 3, body: 'It crashes' }];
    await withScenario([{ match: ['issue', 'list'], stdout: JSON.stringify(raw) }], async (client) => {
      const issues = await client.issueList('octo/repo', { search: '', state: 'open', assignee: 'any', author: 'any', mentioned: false, labels: [], milestone: null });
      expect(issues).toEqual([{ number: 5, title: 'Bug', url: 'https://github.com/octo/repo/issues/5', state: 'OPEN', author: 'octocat', labels: [{ name: 'bug', color: 'ff0000' }], assignees: ['octocat'], milestone: 'v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', commentsCount: 3, body: 'It crashes' }]);
    });
  });

  it('issueList requests a page before an oldest-seen timestamp for "Load more"', async () => {
    await withScenario([{ match: ['issue', 'list'], stdout: '[]' }], async (client, scenario) => {
      await client.issueList('octo/repo', { search: '', state: 'all', assignee: 'any', author: 'any', mentioned: false, labels: [], milestone: null }, '2026-01-01T00:00:00Z');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toContain('sort:updated-desc updated:<2026-01-01T00:00:00Z');
    });
  });

  it('issueDetail caps comments to the latest 20', async () => {
    const comments = Array.from({ length: 25 }, (_, i) => ({ author: { login: `user${i}` }, createdAt: '2026-01-01T00:00:00Z', body: `c${i}`, url: `https://x/${i}` }));
    const raw = { number: 5, title: 'Bug', url: 'https://x', state: 'OPEN', author: { login: 'octocat' }, labels: [], assignees: [], milestone: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', body: '', comments };
    await withScenario([{ match: ['issue', 'view'], stdout: JSON.stringify(raw) }], async (client) => {
      const detail = await client.issueDetail('octo/repo', 5);
      expect(detail.commentsCount).toBe(25);
      expect(detail.comments).toHaveLength(20);
      expect(detail.comments[0].body).toBe('c5');
      expect(detail.comments[19].body).toBe('c24');
    });
  });

  it('issueCreate parses the number and URL from gh output', async () => {
    await withScenario([{ match: ['issue', 'create'], stdout: 'https://github.com/octo/repo/issues/42\n' }], async (client, scenario) => {
      const result = await client.issueCreate('octo/repo', { title: 'New bug', body: 'Details', labels: ['bug'], assignees: ['octocat'] });
      expect(result).toEqual({ number: 42, url: 'https://github.com/octo/repo/issues/42' });
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['issue', 'create', '--repo', 'octo/repo', '--title', 'New bug', '--body-file', '-', '--label', 'bug', '--assignee', 'octocat']);
    });
  });

  it('issueSetState closes or reopens by name', async () => {
    await withScenario([{ match: ['issue', 'close'], stdout: '' }, { match: ['issue', 'reopen'], stdout: '' }], async (client, scenario) => {
      await client.issueSetState('octo/repo', 5, 'closed');
      await client.issueSetState('octo/repo', 5, 'open');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['issue', 'close', '5', '--repo', 'octo/repo']);
      expect(log[1].args).toEqual(['issue', 'reopen', '5', '--repo', 'octo/repo']);
    });
  });

  it('issueCommentAdd sends the body over stdin', async () => {
    await withScenario([{ match: ['issue', 'comment'], stdoutFromStdin: true }], async (client) => {
      await client.issueCommentAdd('octo/repo', 5, 'Looks good');
    });
  });

  it('issueView returns null without calling gh when signed out', async () => {
    const scenario = await createStubScenario([{ match: ['issue', 'view'], stdout: JSON.stringify({ title: 'Should not be reached', body: '', state: 'OPEN' }) }]);
    try {
      const tools = createFakeTools({ ghPath: ghLauncherPath(), env: scenario.env('GH') }); // no ghAccount: signed out
      const client = new GhClient(tools);
      expect(await client.issueView(REF, 42)).toBeNull();
      expect(await readStubLog(scenario.logPath)).toHaveLength(0);
    } finally {
      await scenario.dispose();
    }
  });

  it('issueView maps title, body and state when signed in', async () => {
    const scenario = await createStubScenario([{ match: ['issue', 'view'], stdout: JSON.stringify({ title: 'A bug', body: 'Details', state: 'CLOSED' }) }]);
    try {
      const tools = createFakeTools({ ghPath: ghLauncherPath(), env: scenario.env('GH'), ghAccount: { login: 'octocat', name: null, avatarUrl: null, host: 'github.com', scopes: [], protocol: 'https' } });
      const client = new GhClient(tools);
      expect(await client.issueView(REF, 42)).toEqual({ number: 42, title: 'A bug', body: 'Details', state: 'CLOSED' });
    } finally {
      await scenario.dispose();
    }
  });

  it('labelList and milestoneList parse their JSON', async () => {
    await withScenario(
      [
        { match: ['label', 'list'], stdout: JSON.stringify([{ name: 'bug', color: 'ff0000', description: 'Something is broken' }]) },
        { match: ['milestones'], stdout: JSON.stringify([{ number: 1, title: 'v1' }]) },
      ],
      async (client) => {
        expect(await client.labelList('octo/repo')).toEqual([{ name: 'bug', color: 'ff0000', description: 'Something is broken' }]);
        expect(await client.milestoneList('octo/repo')).toEqual([{ number: 1, title: 'v1' }]);
      },
    );
  });

  describe('releases', () => {
    it('releaseView returns the release URL when one exists', async () => {
      await withScenario([{ match: ['release', 'view', 'v1.0.0'], stdout: JSON.stringify({ url: 'https://github.com/octo/repo/releases/tag/v1.0.0' }) }], async (client) => {
        expect(await client.releaseView(REF, 'v1.0.0')).toEqual({ url: 'https://github.com/octo/repo/releases/tag/v1.0.0' });
      });
    });

    it('releaseView returns null when gh reports the release does not exist', async () => {
      await withScenario([{ match: ['release', 'view'], stderr: 'release not found', exitCode: 1 }], async (client) => {
        expect(await client.releaseView(REF, 'v9.9.9')).toBeNull();
      });
    });

    it('releaseCreate passes --draft by default and reads the body from stdin', async () => {
      await withScenario([{ match: ['release', 'create'], stdout: 'https://github.com/octo/repo/releases/tag/v1.0.0\n' }], async (client, scenario) => {
        const result = await client.releaseCreate(REF, { tag: 'v1.0.0', title: 'v1.0.0', body: '## v1.0.0\n\n- Did a thing\n', draft: true, prerelease: false, targetSha: null });
        expect(result.url).toBe('https://github.com/octo/repo/releases/tag/v1.0.0');
        const log = await readStubLog(scenario.logPath);
        expect(log[0].args).toEqual(['release', 'create', 'v1.0.0', '--repo', 'octo/repo', '--title', 'v1.0.0', '--notes-file', '-', '--draft']);
      });
    });

    it('releaseCreate passes --target when the tag does not exist yet, and omits --draft/--prerelease when both are off', async () => {
      await withScenario([{ match: ['release', 'create'], stdout: 'https://github.com/octo/repo/releases/tag/v1.0.0\n' }], async (client, scenario) => {
        await client.releaseCreate(REF, { tag: 'v1.0.0', title: 'v1.0.0', body: 'notes', draft: false, prerelease: true, targetSha: 'deadbeef' });
        const log = await readStubLog(scenario.logPath);
        expect(log[0].args).toEqual(['release', 'create', 'v1.0.0', '--repo', 'octo/repo', '--title', 'v1.0.0', '--notes-file', '-', '--prerelease', '--target', 'deadbeef']);
      });
    });
  });
});
