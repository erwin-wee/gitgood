import { describe, expect, it } from 'vitest';
import { GhClient } from '../../src/main/gh/gh';
import { GitError } from '../../src/main/git/git';
import { createFakeTools } from '../helpers/fake-tools';
import { createStubScenario, ghLauncherPath, readStubLog, type StubScenario } from '../helpers/gh-stub';

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

const RAW_ITEM = { id: '1', unread: true, reason: 'review_requested', updated_at: '2026-01-02T00:00:00Z', last_read_at: null, subject: { title: 'Add feature', url: 'https://api.github.com/repos/octo/repo/pulls/12', type: 'PullRequest' }, repository: { name: 'repo', owner: { login: 'octo' }, html_url: 'https://github.com/octo/repo' } };

describe('GhClient.notificationsPoll against the gh stub', () => {
  it('parses a 200 response into items and reads Last-Modified/X-Poll-Interval', async () => {
    const body = JSON.stringify([RAW_ITEM]);
    const stdout = ['HTTP/2.0 200 OK', 'X-Poll-Interval: 60', 'Last-Modified: Thu, 25 Oct 2018 16:32:53 GMT', '', body, ''].join('\r\n');
    await withScenario([{ match: 'api notifications', stdout }], async (client, scenario) => {
      const result = await client.notificationsPoll(null);
      expect(result.notModified).toBe(false);
      if (result.notModified) throw new Error('unreachable');
      expect(result.items).toEqual([RAW_ITEM]);
      expect(result.lastModified).toBe('Thu, 25 Oct 2018 16:32:53 GMT');
      expect(result.pollIntervalSeconds).toBe(60);
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['api', 'notifications', '--paginate', '--include']);
    });
  });

  it('sends If-Modified-Since verbatim when polling again', async () => {
    const stdout = ['HTTP/2.0 200 OK', '', '[]', ''].join('\r\n');
    await withScenario([{ match: 'api notifications', stdout }], async (client, scenario) => {
      await client.notificationsPoll('Thu, 25 Oct 2018 16:32:53 GMT');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['api', 'notifications', '--paginate', '--include', '-H', 'If-Modified-Since: Thu, 25 Oct 2018 16:32:53 GMT']);
    });
  });

  it('concatenates multiple --paginate pages into one item list', async () => {
    const stdout = ['HTTP/2.0 200 OK', '', JSON.stringify([RAW_ITEM]), 'HTTP/2.0 200 OK', '', JSON.stringify([{ ...RAW_ITEM, id: '2' }]), ''].join('\n');
    await withScenario([{ match: 'api notifications', stdout }], async (client) => {
      const result = await client.notificationsPoll(null);
      if (result.notModified) throw new Error('unreachable');
      expect(result.items).toHaveLength(2);
    });
  });

  it('treats a 200 with an embedded 304 page as not modified', async () => {
    const stdout = ['HTTP/2.0 304 Not Modified', 'X-Poll-Interval: 45', ''].join('\n');
    await withScenario([{ match: 'api notifications', stdout }], async (client) => {
      const result = await client.notificationsPoll('Thu, 25 Oct 2018 16:32:53 GMT');
      expect(result).toEqual({ notModified: true, pollIntervalSeconds: 45 });
    });
  });

  it('treats a non-zero exit with an empty body as not modified (gh reporting a 304 as a failure)', async () => {
    await withScenario([{ match: 'api notifications', stdout: '', stderr: '', exitCode: 1 }], async (client) => {
      const result = await client.notificationsPoll('Thu, 25 Oct 2018 16:32:53 GMT');
      expect(result).toEqual({ notModified: true, pollIntervalSeconds: null });
    });
  });

  it('still rejects a real error (rate limit) rather than treating it as not-modified', async () => {
    await withScenario([{ match: 'api notifications', stderr: 'HTTP 403: API rate limit exceeded for installation ID 123.', exitCode: 1 }], async (client) => {
      await expect(client.notificationsPoll(null)).rejects.toBeInstanceOf(GitError);
      try {
        await client.notificationsPoll(null);
      } catch (err) {
        expect((err as GitError).info.code).toBe('rate-limited');
      }
    });
  });
});

describe('GhClient inbox write actions against the gh stub', () => {
  it('markThreadRead sends a PATCH to the thread', async () => {
    await withScenario([{ match: 'notifications/threads', stdout: '' }], async (client, scenario) => {
      await client.markThreadRead('42');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['api', '-X', 'PATCH', 'notifications/threads/42']);
    });
  });

  it('markAllNotificationsRead sends a PUT with last_read_at', async () => {
    await withScenario([{ match: 'last_read_at', stdout: '' }], async (client, scenario) => {
      await client.markAllNotificationsRead('2026-01-01T00:00:00.000Z');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['api', '-X', 'PUT', 'notifications', '-f', 'last_read_at=2026-01-01T00:00:00.000Z']);
    });
  });

  it('unsubscribeThread sends a DELETE to the thread subscription', async () => {
    await withScenario([{ match: 'subscription', stdout: '' }], async (client, scenario) => {
      await client.unsubscribeThread('42');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['api', '-X', 'DELETE', 'notifications/threads/42/subscription']);
    });
  });

  it('refreshScopes runs a device-flow auth refresh scoped to the requested scopes', async () => {
    await withScenario([{ match: ['auth', 'refresh'], stderr: '! First copy your one-time code: ABCD-1234\nPress Enter to open https://github.com/login/device in your browser...\n' }], async (client, scenario) => {
      let code: string | null = null;
      const result = await client.refreshScopes('github.com', ['notifications'], (c) => (code = c));
      expect(result.ok).toBe(true);
      expect(code).toBe('ABCD-1234');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['auth', 'refresh', '--hostname', 'github.com', '-s', 'notifications']);
    });
  });
});
