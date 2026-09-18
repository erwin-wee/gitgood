import { describe, expect, it } from 'vitest';
import { GhClient } from '../../src/main/gh/gh';
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

describe('GhClient gist wrappers (settings sync) against the gh stub', () => {
  it('gistFind matches by description in a gists listing', async () => {
    const raw = [
      { id: 'aaa', description: 'Something else', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'bbb', description: 'GitGood settings', updated_at: '2026-02-01T00:00:00Z' },
    ];
    await withScenario([{ match: 'gists', stdout: JSON.stringify(raw) }], async (client, scenario) => {
      const found = await client.gistFind('GitGood settings');
      expect(found).toEqual({ id: 'bbb', updatedAt: '2026-02-01T00:00:00Z' });
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['api', 'gists', '--paginate']);
    });
  });

  it('gistFind returns null when no gist matches the description', async () => {
    await withScenario([{ match: 'gists', stdout: '[]' }], async (client) => {
      expect(await client.gistFind('GitGood settings')).toBeNull();
    });
  });

  it('gistCreate sends the content over stdin and parses the id from the created URL', async () => {
    await withScenario([{ match: 'gist create', stdout: 'https://gist.github.com/octocat/abc123def456\n' }], async (client, scenario) => {
      const id = await client.gistCreate('{"hello":"world"}', 'gitgood-settings.json', 'GitGood settings');
      expect(id).toBe('abc123def456');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['gist', 'create', '--desc', 'GitGood settings', '--filename', 'gitgood-settings.json', '-']);
    });
  });

  it('gistEdit sends the content over stdin with the expected argument shape', async () => {
    await withScenario([{ match: 'gist edit', stdoutFromStdin: true }], async (client, scenario) => {
      await client.gistEdit('abc123', 'gitgood-settings.json', '{"a":1}');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['gist', 'edit', 'abc123', '--filename', 'gitgood-settings.json', '-']);
    });
  });

  it('gistView returns the raw file content', async () => {
    await withScenario([{ match: 'gist view', stdout: '{"a":1}' }], async (client, scenario) => {
      const content = await client.gistView('abc123', 'gitgood-settings.json');
      expect(content).toBe('{"a":1}');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['gist', 'view', 'abc123', '--filename', 'gitgood-settings.json', '--raw']);
    });
  });

  it('gistView returns null on a 404 (gist deleted remotely) instead of throwing', async () => {
    await withScenario([{ match: 'gist view', stderr: "gh: Not Found (HTTP 404)", exitCode: 1 }], async (client) => {
      expect(await client.gistView('gone', 'gitgood-settings.json')).toBeNull();
    });
  });

  it('gistMetadata returns updatedAt for an existing gist', async () => {
    await withScenario([{ match: ['api', 'gists/abc123'], stdout: JSON.stringify({ updated_at: '2026-03-01T00:00:00Z' }) }], async (client) => {
      expect(await client.gistMetadata('abc123')).toEqual({ updatedAt: '2026-03-01T00:00:00Z' });
    });
  });

  it('gistMetadata returns null on a 404 instead of throwing (missing-gist recovery)', async () => {
    await withScenario([{ match: ['api', 'gists/gone'], stderr: 'HTTP 404: Not Found', exitCode: 1 }], async (client) => {
      expect(await client.gistMetadata('gone')).toBeNull();
    });
  });

  it('gistMetadata still throws on a non-404 error', async () => {
    await withScenario([{ match: ['api', 'gists/abc123'], stderr: 'HTTP 500: Internal Server Error', exitCode: 1 }], async (client) => {
      await expect(client.gistMetadata('abc123')).rejects.toThrow();
    });
  });

  it('gistDelete sends the expected argument shape', async () => {
    await withScenario([{ match: 'gist delete', stdout: '' }], async (client, scenario) => {
      await client.gistDelete('abc123');
      const log = await readStubLog(scenario.logPath);
      expect(log[0].args).toEqual(['gist', 'delete', 'abc123']);
    });
  });

  it('gistDelete treats an already-gone gist (404) as success', async () => {
    await withScenario([{ match: 'gist delete', stderr: 'HTTP 404: Not Found', exitCode: 1 }], async (client) => {
      await expect(client.gistDelete('gone')).resolves.toBeUndefined();
    });
  });
});
