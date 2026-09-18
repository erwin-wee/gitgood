import { describe, expect, it } from 'vitest';
import { FetchReleaseProvider, normalizeVersion, parseRelease, type Fetcher } from '../src/main/update/github-provider';

describe('normalizeVersion / parseRelease', () => {
  it('strips a leading v from the tag name', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });

  it('maps the GitHub release JSON shape', () => {
    const info = parseRelease({ tag_name: 'v1.2.3', html_url: 'https://github.com/erwin-wee/gitgood/releases/tag/v1.2.3', body: '  Fixes things.  ', published_at: '2026-01-01T00:00:00Z', prerelease: false, draft: false });
    expect(info).toEqual({ version: '1.2.3', releaseDate: '2026-01-01T00:00:00Z', notes: 'Fixes things.', url: 'https://github.com/erwin-wee/gitgood/releases/tag/v1.2.3', prerelease: false, draft: false });
  });

  it('returns null for a release missing a tag name, and null notes for an empty body', () => {
    expect(parseRelease({})).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ tag_name: 'v1.0.0', body: '   ' })?.notes).toBeNull();
  });

  it('falls back to a constructed release URL when html_url is missing', () => {
    expect(parseRelease({ tag_name: 'v1.0.0' })?.url).toBe('https://github.com/erwin-wee/gitgood/releases/tag/v1.0.0');
  });
});

describe('FetchReleaseProvider', () => {
  it('fetches and parses the latest release, sending an Accept header and the given User-Agent, and never touches the real network (injected fetcher)', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const fetcher: Fetcher = async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v2.0.0', html_url: 'https://x/2.0.0', body: 'notes', published_at: null, prerelease: false, draft: false }) };
    };
    const provider = new FetchReleaseProvider(fetcher, 'GitGood/1.0.0 (test)');
    const release = await provider.fetchLatestRelease();
    expect(seenUrl).toBe('https://api.github.com/repos/erwin-wee/gitgood/releases/latest');
    expect(seenHeaders['User-Agent']).toBe('GitGood/1.0.0 (test)');
    expect(seenHeaders.Accept).toMatch(/github/);
    expect(release).toEqual({ version: '2.0.0', releaseDate: null, notes: 'notes', url: 'https://x/2.0.0', prerelease: false, draft: false });
  });

  it('returns null when the repository has no releases (404)', async () => {
    const fetcher: Fetcher = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const provider = new FetchReleaseProvider(fetcher, 'ua');
    expect(await provider.fetchLatestRelease()).toBeNull();
  });

  it('throws on any other non-ok response', async () => {
    const fetcher: Fetcher = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const provider = new FetchReleaseProvider(fetcher, 'ua');
    await expect(provider.fetchLatestRelease()).rejects.toThrow(/500/);
  });
});
