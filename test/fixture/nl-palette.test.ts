import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { undoLastCommit } from '../../src/main/git/commit';
import { NlPaletteService } from '../../src/main/ai/nlPalette';
import type { NlPlan, NlProgressEvent } from '../../src/shared/types';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types';
import { createFakeTools } from '../helpers/fake-tools';
import { claudeLauncherPath, createStubScenario } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';
import type { Store } from '../../src/main/store';

function fakeStore(ai: Partial<AppSettings['ai']> = {}): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', ...ai } };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

/** Wires the same real wrappers the production ipc.ts dispatcher calls, for the one action this suite exercises. */
function realDispatcher(git: GitClient) {
  return async (action: string, repoPath: string, _args: unknown[]): Promise<unknown> => {
    if (action === 'git.undoCommit') return undoLastCommit(git, repoPath);
    throw new Error(`unhandled test dispatch: ${action}`);
  };
}

describe.skipIf(!hasGitSync())('NlPaletteService end-to-end against the claude stub', () => {
  it('plans "undo last commit keep changes" as reset --soft HEAD~1, recomputes risk, and runs it', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'first', files: { 'a.txt': 'one\n' } }, { message: 'second', files: { 'a.txt': 'two\n' } }] });
    try {
      const stubResponse = { is_error: false, structured_output: { clarifyingQuestion: null, steps: [{ argv: ['reset', '--soft', 'HEAD~1'], explanation: 'Undo the last commit but keep its changes staged.', risk: 'safe' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new NlPaletteService(fakeStore(), tools, git);
        service.setDispatcher(realDispatcher(git));

        const plan: NlPlan = await service.plan(repo.path, 'undo last commit keep changes', null, null);
        expect(plan.clarifyingQuestion).toBeNull();
        expect(plan.steps).toHaveLength(1);
        const step = plan.steps[0];
        expect(step.executable).toBe(true);
        expect(step.mappedAction).toBe('git.undoCommit');
        // The model called this "safe"; the policy independently classifies a soft reset as changes-history
        // and the higher of the two must win.
        expect(step.risk).toBe('changes-history');

        const previewed = await service.preview(repo.path, step);
        expect(previewed.preview).not.toBeNull();
        expect(previewed.preview!.lines.join('\n')).toContain('second');

        const events: NlProgressEvent['phase'][] = [];
        const result = await service.run(repo.path, plan, [step.id], (e) => events.push(e.phase));
        expect(result.failedStep).toBeNull();
        expect(result.completed).toEqual([step.id]);
        expect(events).toEqual(['running', 'done']);

        // HEAD moved back one commit ("second" undone)...
        expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('first');
        // ...but its changes are still present (staged).
        expect(repo.git(['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
        const content = await readFile(`${repo.path}/a.txt`, 'utf8');
        expect(content).toBe('two\n');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('preview() re-verifies refs and marks a step non-executable once its ref no longer resolves', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'first', files: { 'a.txt': 'one\n' } }, { message: 'second', files: { 'a.txt': 'two\n' } }] });
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const service = new NlPaletteService(fakeStore(), tools, git);

      // A previously-planned step naming a branch that has since been deleted.
      const staleStep = { id: 'step-0', argv: ['branch', '-d', 'gone-branch'], display: 'branch -d gone-branch', explanation: 'delete a merged branch', risk: 'changes-history' as const, executable: true, refusalReason: null, mappedAction: 'git.branch.delete', mappedArgs: ['gone-branch', false], preview: null };
      const previewed = await service.preview(repo.path, staleStep);
      expect(previewed.executable).toBe(false);
      expect(previewed.refusalReason).toMatch(/gone-branch/);
      expect(previewed.mappedAction).toBeNull();

      // A step naming a branch that does exist gets a real preview instead.
      const liveStep = { ...staleStep, mappedArgs: ['main', false] };
      const livePreviewed = await service.preview(repo.path, liveStep);
      expect(livePreviewed.executable).toBe(true);
      expect(livePreviewed.preview).not.toBeNull();
    } finally {
      await repo.dispose();
    }
  });

  it('never executes a denylisted step even if a tampered plan claims it is executable', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'x\n' } }] });
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const service = new NlPaletteService(fakeStore(), tools, git);
      service.setDispatcher(realDispatcher(git));

      // A step a compromised/buggy renderer might send back with a forged mappedAction; run() must
      // re-derive executability/mappedAction from argv itself via the pure policy, never trust this.
      const tamperedPlan: NlPlan = {
        id: 'plan-1',
        request: 'force push',
        model: 'test',
        clarifyingQuestion: null,
        steps: [{ id: 'step-0', argv: ['push', '--force'], display: 'push --force', explanation: 'force push', risk: 'safe', executable: true, refusalReason: null, mappedAction: 'git.push', mappedArgs: [{ force: true, setUpstream: false, remote: null, branch: null, tags: false }], preview: null }],
      };
      const result = await service.run(repo.path, tamperedPlan, ['step-0'], () => undefined);
      expect(result.failedStep).toBe('step-0');
      expect(result.completed).toEqual([]);
      expect(result.error?.message).toMatch(/force pushes without lease/);
    } finally {
      await repo.dispose();
    }
  });

  it('refuses a second concurrent request for the same repository', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'x\n' } }] });
    try {
      const stubResponse = { is_error: false, structured_output: { clarifyingQuestion: null, steps: [{ argv: ['status'], explanation: 'check status', risk: 'safe' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse), delayMs: 200 }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new NlPaletteService(fakeStore(), tools, git);
        service.setDispatcher(realDispatcher(git));

        const first = service.plan(repo.path, 'what changed', null, null);
        await expect(service.plan(repo.path, 'again', null, null)).rejects.toThrow(/already running/);
        await first;
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });
});
