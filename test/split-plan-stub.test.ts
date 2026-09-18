import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { GitClient } from '../src/main/git/git';
import { getStatus } from '../src/main/git/status';
import { getWorkingDiff } from '../src/main/git/diff';
import { SplitterService } from '../src/main/ai/splitter';
import { computeHunkId } from '../src/main/ai/splitter-core';
import type { Store } from '../src/main/store';
import { createFakeTools } from './helpers/fake-tools';
import { claudeLauncherPath, createStubScenario } from './helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from './helpers/repo';

function fakeStore(): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli' } };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

describe.skipIf(!hasGitSync())('SplitterService.plan against the claude stub (real git)', () => {
  it('calls the model and returns a validated two-commit plan, with no hunk left unassigned', async () => {
    const repo: TestRepo = await createRepo({
      commits: [{ message: 'init', files: { 'a.ts': Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n', 'b.ts': 'x1\nx2\nx3\n' } }],
    });
    try {
      await repo.write('a.ts', ['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n');
      await repo.write('b.ts', 'x1\nx2 changed\nx3\n');

      const git = new GitClient(repo.tools());
      const status = await getStatus(git, repo.path);
      const fileA = status.files.find((f) => f.path === 'a.ts')!;
      const fileB = status.files.find((f) => f.path === 'b.ts')!;
      const diffA = await getWorkingDiff(git, repo.path, fileA, { hideWhitespace: false });
      const diffB = await getWorkingDiff(git, repo.path, fileB, { hideWhitespace: false });
      if (diffA.kind !== 'text' || diffB.kind !== 'text') throw new Error('expected text diffs');
      const idA0 = computeHunkId('a.ts', diffA.hunks[0]);
      const idA1 = computeHunkId('a.ts', diffA.hunks[1]);
      const idB0 = computeHunkId('b.ts', diffB.hunks[0]);

      const stubResponse = {
        is_error: false,
        structured_output: {
          commits: [
            { summary: 'Update a.ts', description: '', hunkIds: [idA0, idA1], wholeFiles: [], rationale: 'Both hunks touch a.ts.' },
            { summary: 'Update b.ts', description: '', hunkIds: [idB0], wholeFiles: [], rationale: 'Unrelated change in b.ts.' },
          ],
        },
      };
      // Match on a phrase unique to SPLIT_SYSTEM_PROMPT so this coexists with other AI features' stub rules in one scenario.
      const scenario = await createStubScenario([{ match: "group a developer's uncommitted changes into a small, ordered set of coherent commits", stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const splitter = new SplitterService(fakeStore(), tools, git);
        const plan = await splitter.plan(repo.path, ['a.ts', 'b.ts']);

        expect(plan.commits).toHaveLength(2);
        expect(plan.commits.map((c) => c.summary)).toEqual(['Update a.ts', 'Update b.ts']);
        expect(plan.hunks).toHaveLength(3);
        expect(plan.unassigned).toEqual([]);
        expect(plan.warnings).toEqual([]);
        expect(plan.model).toBeTruthy();
        expect(plan.startSha).toBe((await git.stdout(repo.path, ['rev-parse', 'HEAD'])).trim());
        expect(Object.keys(plan.fileHashes).sort()).toEqual(['a.ts', 'b.ts']);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('rejects with a not-configured error when the AI provider is disabled, without running any process', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': 'a\n', 'b.ts': 'b\n' } }] });
    try {
      await repo.write('a.ts', 'a changed\n');
      await repo.write('b.ts', 'b changed\n');
      const git = new GitClient(repo.tools());
      const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'disabled' } };
      const store = { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
      const splitter = new SplitterService(store, repo.tools(), git);
      await expect(splitter.plan(repo.path, ['a.ts', 'b.ts'])).rejects.toThrow(/turned off/);
    } finally {
      await repo.dispose();
    }
  });
});
