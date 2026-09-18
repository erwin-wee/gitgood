import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { GhClient } from '../../src/main/gh/gh';
import { ReleaseNotesService } from '../../src/main/ai/release-notes';
import type { AppSettings, GitHubRepoRef } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import type { Store } from '../../src/main/store';
import type { RepositoryManager } from '../../src/main/repo/manager';
import { createFakeTools } from '../helpers/fake-tools';
import { createStubScenario, ghLauncherPath } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

const REF: GitHubRepoRef = { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' };

function fakeStore(): Store {
  return { getSettings: () => DEFAULT_SETTINGS as AppSettings, getApiKey: () => null } as unknown as Store;
}

function fakeRepos(ref: GitHubRepoRef | null): RepositoryManager {
  return { detectGitHub: async () => ref } as unknown as RepositoryManager;
}

describe.skipIf(!hasGitSync())('ReleaseNotesService.range against a real repo and the gh stub', () => {
  it('merges pull request titles fetched from gh into the range preview', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'Initial commit', files: { 'README.md': '# Fixture\n' } }] });
    try {
      repo.git(['tag', 'v0.1.0'], repo.path);
      repo.commit({ message: 'Fix crash on startup (#12)', files: { 'src/app.ts': 'export const value = 2;\n' } });

      const scenario = await createStubScenario([{ match: ['pr', 'view', '12'], stdout: JSON.stringify({ number: 12, title: 'Fix crash on startup', url: 'https://github.com/octo/repo/pull/12', author: { login: 'octocat' }, headRefName: 'fix', baseRefName: 'main', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', labels: [{ name: 'bug' }] }) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, ghPath: ghLauncherPath(), env: { ...repo.env, ...scenario.env('GH') }, ghAccount: { login: 'octocat', name: null, avatarUrl: null, host: 'github.com', scopes: ['repo'], protocol: 'https' } });
        const git = new GitClient(tools);
        const gh = new GhClient(tools);
        const service = new ReleaseNotesService(fakeStore(), tools, git, gh, fakeRepos(REF));

        const result = await service.range(repo.path, { from: null, to: 'HEAD', includePrs: true });

        expect(result.latestTag).toBe('v0.1.0');
        expect(result.rootFallback).toBe(false);
        expect(result.commits.map((c) => c.subject)).toEqual(['Fix crash on startup (#12)']);
        expect(result.prs).toEqual([{ number: 12, title: 'Fix crash on startup', labels: ['bug'], author: 'octocat', url: 'https://github.com/octo/repo/pull/12' }]);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('does not fetch pull request titles when includePrs is false', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'Initial commit', files: { 'README.md': '# Fixture\n' } }] });
    try {
      repo.git(['tag', 'v0.1.0'], repo.path);
      repo.commit({ message: 'Fix crash on startup (#12)', files: { 'src/app.ts': 'export const value = 2;\n' } });

      const scenario = await createStubScenario([]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, ghPath: ghLauncherPath(), env: { ...repo.env, ...scenario.env('GH') }, ghAccount: { login: 'octocat', name: null, avatarUrl: null, host: 'github.com', scopes: ['repo'], protocol: 'https' } });
        const git = new GitClient(tools);
        const gh = new GhClient(tools);
        const service = new ReleaseNotesService(fakeStore(), tools, git, gh, fakeRepos(REF));

        const result = await service.range(repo.path, { from: null, to: 'HEAD', includePrs: false });
        expect(result.prs).toEqual([]);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('reports rootFallback and a null latestTag when the repository has no tags', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'Initial commit', files: { 'a.txt': 'hi\n' } }] });
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const gh = new GhClient(tools);
      const service = new ReleaseNotesService(fakeStore(), tools, git, gh, fakeRepos(null));

      const result = await service.range(repo.path, { from: null, to: 'HEAD', includePrs: true });
      expect(result.latestTag).toBeNull();
      expect(result.rootFallback).toBe(true);
      expect(result.range.from).toBeNull();
    } finally {
      await repo.dispose();
    }
  });
});
