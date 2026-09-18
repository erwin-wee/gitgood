import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { GhClient } from '../../src/main/gh/gh';
import { PrDraftService } from '../../src/main/ai/prDraft';
import type { AppSettings } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import type { Store } from '../../src/main/store';
import type { RepositoryManager } from '../../src/main/repo/manager';
import { createFakeTools } from '../helpers/fake-tools';
import { claudeLauncherPath, createStubScenario } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

function fakeStore(ai: Partial<AppSettings['ai']> = {}): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', ...ai } };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

function fakeRepos(): RepositoryManager {
  return { detectGitHub: async () => null } as unknown as RepositoryManager;
}

const TEMPLATE = ['## Summary', '', 'Describe the change.', '', '## Testing', '', 'How was this tested?', '', '## Checklist', '', '- [ ] Tests added', ''].join('\n');

describe.skipIf(!hasGitSync())('PrDraftService end-to-end against the claude stub', () => {
  it('fills every template heading and reports no truncation for a small branch', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      await repo.write('.github/pull_request_template.md', TEMPLATE);
      repo.git(['add', '.github/pull_request_template.md']);
      repo.git(['commit', '-q', '-m', 'add template']);
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'Fixes #42: add retry', files: { 'a.txt': '2\n' } });
      repo.commit({ message: 'Second commit', files: { 'b.txt': '1\n' } });

      const stubResponse = {
        is_error: false,
        structured_output: {
          title: 'Add retry logic.',
          body: '## Summary\nAdds a retry loop.\n\n## Testing\nRan the suite.\n\n## Checklist\n- [ ] Tests added\n',
          linkedIssues: [{ number: 42, keyword: 'closes' }],
          templateSectionsFilled: ['## Summary', '## Testing', '## Checklist'],
        },
      };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const gh = new GhClient(tools);
        const service = new PrDraftService(fakeStore(), tools, git, gh, fakeRepos());
        const events: string[] = [];
        const draft = await service.draft(repo.path, { base: 'main', head: 'feature', existingTitle: '', existingBody: '' }, (phase) => events.push(phase));

        expect(draft.title).toBe('Add retry logic'); // trailing period stripped
        expect(draft.body).toContain('## Summary');
        expect(draft.body).toContain('## Testing');
        expect(draft.body).toContain('## Checklist');
        expect(draft.body.indexOf('## Summary')).toBeLessThan(draft.body.indexOf('## Testing'));
        expect(draft.body.indexOf('## Testing')).toBeLessThan(draft.body.indexOf('## Checklist'));
        expect(draft.restored).toBe(false);
        expect(draft.truncated).toBe(false);
        expect(draft.linkedIssues).toEqual([{ number: 42, keyword: 'closes' }]);
        expect(events).toEqual(['started', 'thinking', 'writing', 'done']);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('rebuilds the body and marks it restored when the model drops a heading', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      await repo.write('.github/pull_request_template.md', TEMPLATE);
      repo.git(['add', '.github/pull_request_template.md']);
      repo.git(['commit', '-q', '-m', 'add template']);
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'add retry', files: { 'a.txt': '2\n' } });

      const stubResponse = { is_error: false, structured_output: { title: 'Add retry', body: 'Just a paragraph, no headings.', linkedIssues: [], templateSectionsFilled: [] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const gh = new GhClient(tools);
        const service = new PrDraftService(fakeStore(), tools, git, gh, fakeRepos());
        const draft = await service.draft(repo.path, { base: 'main', head: 'feature', existingTitle: '', existingBody: '' }, () => undefined);
        expect(draft.restored).toBe(true);
        expect(draft.body).toContain('## Summary');
        expect(draft.body).toContain('## Testing');
        expect(draft.body).toContain('## Checklist');
        expect(draft.body).toContain('Just a paragraph, no headings.');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('rejects with no commits ahead of the base branch', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: repo.env });
      const git = new GitClient(tools);
      const gh = new GhClient(tools);
      const service = new PrDraftService(fakeStore(), tools, git, gh, fakeRepos());
      await expect(service.draft(repo.path, { base: 'main', head: 'main', existingTitle: '', existingBody: '' }, () => undefined)).rejects.toThrow(/no commits ahead/);
    } finally {
      await repo.dispose();
    }
  });

  it('cancelling mid-draft rejects the call and leaves no active state behind', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'add x', files: { 'a.txt': '2\n' } });
      const stubResponse = { is_error: false, structured_output: { title: 'x', body: 'y', linkedIssues: [], templateSectionsFilled: [] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse), delayMs: 2000 }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const gh = new GhClient(tools);
        const service = new PrDraftService(fakeStore(), tools, git, gh, fakeRepos());
        const events: string[] = [];
        const promise = service.draft(repo.path, { base: 'main', head: 'feature', existingTitle: '', existingBody: '' }, (phase) => events.push(phase));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(service.isActive()).toBe(true);
        service.cancel();
        await expect(promise).rejects.toThrow();
        expect(service.isActive()).toBe(false);
        expect(events).toContain('thinking');
        expect(events).not.toContain('done');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('reports a not-found base branch instead of fetching it', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: repo.env });
      const git = new GitClient(tools);
      const gh = new GhClient(tools);
      const service = new PrDraftService(fakeStore(), tools, git, gh, fakeRepos());
      await expect(service.draft(repo.path, { base: 'never-fetched', head: 'main', existingTitle: '', existingBody: '' }, () => undefined)).rejects.toThrow(/Fetch first/);
    } finally {
      await repo.dispose();
    }
  });
});
