import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { ExplainService } from '../../src/main/ai/explain';
import type { AppSettings } from '../../src/shared/types';
import { DEFAULT_SETTINGS, EXPLAIN_FOLLOWUP_LIMIT } from '../../src/shared/types';
import { createFakeTools } from '../helpers/fake-tools';
import { claudeLauncherPath, createStubScenario, readStubLog } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';
import type { Store } from '../../src/main/store';

function fakeStore(ai: Partial<AppSettings['ai']> = {}): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', ...ai } };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

const EXPLAIN_STUB = { is_error: false, structured_output: { whatChanged: 'Added a null check before returning the sum.', why: 'Likely to avoid a crash when a is missing.', impact: 'Callers passing a null a no longer crash.', watchOutFor: ['Confirm b is never null too'], references: [{ path: 'math.ts', line: 1, label: 'the new null check' }, { path: 'not-in-diff.ts', line: 1, label: 'a reference to a file outside the commit' }] } };

const FOLLOWUP_STUB = { is_error: false, structured_output: { answer: 'Because a null a previously reached the addition and crashed.' } };

async function mathRepo(): Promise<TestRepo> {
  return createRepo({
    commits: [
      { message: 'init', files: { 'math.ts': 'return a + b;\n' } },
      { message: 'add null check', files: { 'math.ts': 'if (a === null) return b;\nreturn a + b;\n' } },
    ],
  });
}

describe.skipIf(!hasGitSync())('ExplainService end-to-end against the claude stub', () => {
  it('produces a validated explanation, dropping a reference to a file outside the commit', async () => {
    const repo = await mathRepo();
    try {
      const scenario = await createStubScenario([
        { match: 'You explain a Git change', stdout: JSON.stringify(EXPLAIN_STUB) },
        { match: '--version', stdout: 'gitgood-stub-claude 1.0.0\n' },
      ]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ExplainService(fakeStore(), tools, git);
        const sha = repo.git(['rev-parse', 'HEAD']).trim();
        const explanation = await service.explain(repo.path, { kind: 'commit', sha });
        expect(explanation.whatChanged).toContain('null check');
        expect(explanation.droppedReferences).toBe(1);
        expect(explanation.references).toEqual([{ path: 'math.ts', line: 1, label: 'the new null check' }]);
        expect(explanation.truncated).toBe(false);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('caches the explanation for the same target, without calling the backend again', async () => {
    const repo = await mathRepo();
    try {
      const scenario = await createStubScenario([{ match: 'You explain a Git change', stdout: JSON.stringify(EXPLAIN_STUB) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ExplainService(fakeStore(), tools, git);
        const sha = repo.git(['rev-parse', 'HEAD']).trim();
        await service.explain(repo.path, { kind: 'commit', sha });
        await service.explain(repo.path, { kind: 'commit', sha });
        const invocations = await readStubLog(scenario.logPath);
        expect(invocations).toHaveLength(1);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('rejects a response with an empty "whatChanged" section as invalid output', async () => {
    const repo = await mathRepo();
    try {
      const scenario = await createStubScenario([{ match: 'You explain a Git change', stdout: JSON.stringify({ is_error: false, structured_output: { whatChanged: '', why: '', impact: '', watchOutFor: [], references: [] } }) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ExplainService(fakeStore(), tools, git);
        const sha = repo.git(['rev-parse', 'HEAD']).trim();
        await expect(service.explain(repo.path, { kind: 'commit', sha })).rejects.toThrow(/empty explanation/);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('answers a follow-up question, reusing the cached explanation context', async () => {
    const repo = await mathRepo();
    try {
      const scenario = await createStubScenario([
        { match: 'You explain a Git change', stdout: JSON.stringify(EXPLAIN_STUB) },
        { match: 'You are answering a follow-up question', stdout: JSON.stringify(FOLLOWUP_STUB) },
      ]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ExplainService(fakeStore(), tools, git);
        const sha = repo.git(['rev-parse', 'HEAD']).trim();
        const target = { kind: 'commit' as const, sha };
        await service.explain(repo.path, target);
        const answer = await service.followUp(repo.path, target, [], 'why was the check added?');
        expect(answer).toContain('crashed');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('refuses a follow-up once the per-explanation limit is reached, without calling the backend', async () => {
    const repo = await mathRepo();
    try {
      const scenario = await createStubScenario([{ match: 'You are answering a follow-up question', stdout: JSON.stringify(FOLLOWUP_STUB) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ExplainService(fakeStore(), tools, git);
        const sha = repo.git(['rev-parse', 'HEAD']).trim();
        const target = { kind: 'commit' as const, sha };
        const fullHistory = Array.from({ length: EXPLAIN_FOLLOWUP_LIMIT }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
        await expect(service.followUp(repo.path, target, fullHistory, 'one more?')).rejects.toThrow(/up to 5 follow-up/);
        const invocations = await readStubLog(scenario.logPath);
        expect(invocations).toHaveLength(0);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('surfaces a not-configured error when AI is disabled, without running an external process', async () => {
    const repo = await mathRepo();
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const service = new ExplainService(fakeStore({ provider: 'disabled' }), tools, git);
      const sha = repo.git(['rev-parse', 'HEAD']).trim();
      await expect(service.explain(repo.path, { kind: 'commit', sha })).rejects.toThrow(/turned off/);
    } finally {
      await repo.dispose();
    }
  });
});
