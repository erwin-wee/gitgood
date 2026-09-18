import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { RebasePlanService } from '../../src/main/ai/rebasePlan';
import type { AppSettings } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { createFakeTools } from '../helpers/fake-tools';
import { claudeLauncherPath, createStubScenario } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';
import type { Store } from '../../src/main/store';

function fakeStore(ai: Partial<AppSettings['ai']> = {}): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', ...ai } };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

async function buildFixture(): Promise<{ repo: TestRepo; real: string; wip: string; typo: string }> {
  const repo = await createRepo({ commits: [{ message: 'Initial commit on main', files: { 'README.md': '# repo\n' } }], branches: { feature: undefined }, checkout: 'feature' });
  const real = repo.commit({ message: 'Add real feature', files: { 'src/feature.ts': 'export const value = 1;\n' } });
  const wip = repo.commit({ message: 'wip', files: { 'src/feature.ts': 'export const value = 1;\n// wip\n' } });
  const typo = repo.commit({ message: 'fix typo', files: { 'docs/notes.md': 'helllo\n' } });
  return { repo, real, wip, typo };
}

describe.skipIf(!hasGitSync())('RebasePlanService end-to-end against the claude stub', () => {
  it('plans a squash + reword against the real range and validates the model output', async () => {
    const { repo, real, wip, typo } = await buildFixture();
    try {
      const stubResponse = {
        is_error: false,
        structured_output: {
          rows: [
            { sha: real, action: 'pick', squashInto: null, message: 'Add real feature', rationale: '' },
            { sha: wip, action: 'squash', squashInto: real, message: 'Add real feature', rationale: 'fixup' },
            { sha: typo, action: 'reword', squashInto: null, message: 'Fix a typo in the docs', rationale: 'unclear message' },
          ],
        },
      };
      const scenario = await createStubScenario([{ match: 'interactive-rebase cleanup', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new RebasePlanService(fakeStore(), tools, git);
        const plan = await service.plan(repo.path, 'main', null);
        expect(plan.base).toBe('main');
        expect(plan.rows.map((r) => r.action)).toEqual(['pick', 'squash', 'reword']);
        expect(plan.rows[1].squashInto).toBe(real);
        expect(plan.rows[2].message).toBe('Fix a typo in the docs');
        expect(plan.alreadyTidy).toBe(false);
        expect(plan.warnings).toHaveLength(0);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('repairs an incomplete model plan (omitted commit, invalid squash target)', async () => {
    const { repo, real, typo } = await buildFixture();
    try {
      // Omits `wip` entirely and squashes `typo` into a sha that does not exist.
      const stubResponse = { is_error: false, structured_output: { rows: [{ sha: real, action: 'pick', squashInto: null, message: 'Add real feature', rationale: '' }, { sha: typo, action: 'squash', squashInto: 'deadbeef', message: '', rationale: '' }] } };
      const scenario = await createStubScenario([{ match: 'interactive-rebase cleanup', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new RebasePlanService(fakeStore(), tools, git);
        const plan = await service.plan(repo.path, 'main', null);
        expect(plan.rows).toHaveLength(3);
        expect(plan.rows[1]).toMatchObject({ action: 'pick' }); // the omitted "wip" commit, added back in position
        expect(plan.rows[2]).toMatchObject({ action: 'pick' }); // downgraded: invalid squash target
        expect(plan.warnings.length).toBeGreaterThan(0);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('refuses to plan when the working tree is dirty', async () => {
    const { repo } = await buildFixture();
    try {
      await repo.write('src/feature.ts', 'export const value = 2; // uncommitted\n');
      const scenario = await createStubScenario([]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new RebasePlanService(fakeStore(), tools, git);
        await expect(service.plan(repo.path, 'main', null)).rejects.toThrow(/commit or stash/i);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('reports a pre-flight summary without calling the model', async () => {
    const { repo } = await buildFixture();
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const service = new RebasePlanService(fakeStore(), tools, git);
      const preflight = await service.preflight(repo.path, 'main', null);
      expect(preflight.resolvedBase).toBe('main');
      expect(preflight.count).toBe(3);
      expect(preflight.pushedCount).toBe(0);
      expect(preflight.hasMergeCommit).toBe(false);
    } finally {
      await repo.dispose();
    }
  });
});
