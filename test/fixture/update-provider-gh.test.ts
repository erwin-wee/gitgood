import { describe, expect, it } from 'vitest';
import { GhClient } from '../../src/main/gh/gh';
import { GhCliReleaseProvider } from '../../src/main/update/github-provider';
import { createFakeTools } from '../helpers/fake-tools';
import { createStubScenario, ghLauncherPath } from '../helpers/gh-stub';

async function withProvider(rules: Parameters<typeof createStubScenario>[0], fn: (provider: GhCliReleaseProvider) => Promise<void>): Promise<void> {
  const scenario = await createStubScenario(rules);
  try {
    const tools = createFakeTools({ ghPath: ghLauncherPath(), env: scenario.env('GH') });
    const provider = new GhCliReleaseProvider(new GhClient(tools));
    await fn(provider);
  } finally {
    await scenario.dispose();
  }
}

describe('GhCliReleaseProvider against the gh stub', () => {
  it('fetches and parses the latest release via `gh api repos/erwin-wee/gitgood/releases/latest`', async () => {
    await withProvider(
      [{ match: ['api', 'repos/erwin-wee/gitgood/releases/latest'], stdout: JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/erwin-wee/gitgood/releases/tag/v9.9.9', body: 'Release notes', published_at: '2026-02-01T00:00:00Z', prerelease: false, draft: false }) }],
      async (provider) => {
        const release = await provider.fetchLatestRelease();
        expect(release).toEqual({ version: '9.9.9', releaseDate: '2026-02-01T00:00:00Z', notes: 'Release notes', url: 'https://github.com/erwin-wee/gitgood/releases/tag/v9.9.9', prerelease: false, draft: false });
      },
    );
  });

  it('returns null when the repository has no releases (HTTP 404)', async () => {
    await withProvider([{ match: ['api', 'repos/erwin-wee/gitgood/releases/latest'], stderr: 'HTTP 404: Not Found', exitCode: 1 }], async (provider) => {
      expect(await provider.fetchLatestRelease()).toBeNull();
    });
  });

  it('propagates other errors (e.g. not signed in) instead of silently reporting no release', async () => {
    await withProvider([{ match: ['api', 'repos/erwin-wee/gitgood/releases/latest'], stderr: 'HTTP 401: Bad credentials', exitCode: 1 }], async (provider) => {
      await expect(provider.fetchLatestRelease()).rejects.toThrow();
    });
  });
});
