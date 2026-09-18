import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { ConflictResolver } from '../../src/main/ai/resolver';
import type { AppSettings } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { createFakeTools } from '../helpers/fake-tools';
import { claudeLauncherPath, createStubScenario } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';
import type { Store } from '../../src/main/store';

function fakeStore(ai: Partial<AppSettings['ai']> = {}, trustedRepoConfigs: Record<string, boolean> = {}): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', ...ai } };
  return {
    getSettings: () => settings,
    getApiKey: () => null,
    getRepoConfigTrust: (repoPath: string) => trustedRepoConfigs[repoPath],
    setRepoConfigTrust: (repoPath: string, trusted: boolean) => {
      trustedRepoConfigs[repoPath] = trusted;
    },
  } as unknown as Store;
}

const CONFLICTED_FILE = ['function total(a, b) {', '<<<<<<< HEAD', '  return a + b; // simple sum', '=======', '  return a + b + 0; // keep explicit zero for clarity', '>>>>>>> feature', '}', ''].join('\n');

describe.skipIf(!hasGitSync())('ConflictResolver end-to-end against the claude stub', () => {
  it('resolves a conflicted file using the structured JSON the stub CLI returns, without any network access', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      const stubResponse = {
        is_error: false,
        structured_output: {
          resolutions: [{ id: 0, resolved: '  return a + b; // simple sum', rationale: 'Kept the simpler, equivalent expression from both sides.', confidence: 'high' }],
        },
      };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore(), tools, git);
        const events: string[] = [];
        const result = await resolver.resolveFile(repo.path, 'math.ts', (_path, phase) => events.push(phase), new AbortController().signal);
        expect(result.ok).toBe(true);
        expect(result.error).toBeNull();
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({ id: 0, confidence: 'high' });
        expect(result.staged).toBe(true); // DEFAULT_SETTINGS.ai.autoStageAfterResolve is true
        expect(events).toEqual(['started', 'thinking', 'writing', 'done']);
        const written = await readFile(`${repo.path}/math.ts`, 'utf8');
        expect(written).not.toContain('<<<<<<<');
        expect(written).toContain('return a + b; // simple sum');
        expect(repo.git(['diff', '--cached', '--name-only']).trim()).toBe('math.ts');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('reports an error instead of throwing when the model output contains conflict markers', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: '<<<<<<< still broken', rationale: 'oops', confidence: 'low' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore(), tools, git);
        const result = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/still contained conflict markers/);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('surfaces a not-configured error when AI is disabled, without ever running an external process', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const resolver = new ConflictResolver(fakeStore({ provider: 'disabled' }), tools, git);
      const result = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/turned off/);
    } finally {
      await repo.dispose();
    }
  });

  it('a failing post-resolution check blocks auto-staging and is reported on the result', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: '  return a + b; // simple sum', rationale: 'ok', confidence: 'high' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore({ postResolveCheck: 'node -e "process.exit(2)"' }), tools, git);
        const result = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
        expect(result.ok).toBe(true);
        expect(result.staged).toBe(false);
        expect(result.check).toMatchObject({ ok: false, exitCode: 2, fromRepo: false });
        expect(repo.git(['diff', '--cached', '--name-only']).trim()).toBe('');
        // Resolved content is still written to disk even though it was not staged.
        const written = await readFile(`${repo.path}/math.ts`, 'utf8');
        expect(written).not.toContain('<<<<<<<');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('a passing post-resolution check allows auto-staging to proceed', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: '  return a + b; // simple sum', rationale: 'ok', confidence: 'high' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore({ postResolveCheck: 'node -e "process.exit(0)"' }), tools, git);
        const result = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
        expect(result.check).toMatchObject({ ok: true, exitCode: 0 });
        expect(result.staged).toBe(true);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('runs a trusted repository check command in preference to the user setting, labelled as coming from the repository', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      await repo.write('.gitgood/config.json', JSON.stringify({ postResolveCheck: 'node -e "process.exit(0)"' }));
      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: '  return a + b; // simple sum', rationale: 'ok', confidence: 'high' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore({ postResolveCheck: 'node -e "process.exit(2)"' }, { [repo.path]: true }), tools, git);
        const result = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
        expect(result.check).toMatchObject({ ok: true, fromRepo: true, command: 'node -e "process.exit(0)"' });
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('never runs an untrusted repository check command, falling back to the user setting', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      await repo.write('.gitgood/config.json', JSON.stringify({ postResolveCheck: 'node -e "process.exit(2)"' }));
      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: '  return a + b; // simple sum', rationale: 'ok', confidence: 'high' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        // Never trusted (no entry in the trust map at all).
        const resolver = new ConflictResolver(fakeStore({ postResolveCheck: 'node -e "process.exit(0)"' }), tools, git);
        const result = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
        expect(result.check).toMatchObject({ ok: true, fromRepo: false, command: 'node -e "process.exit(0)"' });
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('a checkOutput retry re-resolves from the true original even though the file on disk no longer has markers', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'math.ts': 'placeholder\n' } }] });
    try {
      await repo.write('math.ts', CONFLICTED_FILE);
      const firstResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: '  return a + b; // first attempt', rationale: 'first', confidence: 'high' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(firstResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore({ postResolveCheck: 'node -e "process.exit(2)"' }), tools, git);
        const first = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal);
        expect(first.ok).toBe(true);
        expect(first.staged).toBe(false);
        expect(first.check?.ok).toBe(false);
        const onDisk = await readFile(`${repo.path}/math.ts`, 'utf8');
        expect(onDisk).not.toContain('<<<<<<<'); // markers are gone; a naive retry could not re-read them from disk

        const retry = await resolver.resolveFile(repo.path, 'math.ts', () => undefined, new AbortController().signal, undefined, {
          checkOutput: { command: first.check!.command, tail: first.check!.outputTail, original: first.original! },
        });
        expect(retry.ok).toBe(true);
        expect(retry.error).toBeNull();
        const finalContent = await readFile(`${repo.path}/math.ts`, 'utf8');
        expect(finalContent).toContain('first attempt'); // same stub rule fires again; the point is that it succeeded at all
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('useSideForBlock rewrites a single block from the original snapshot, keeping the AI text for the others', async () => {
    const twoBlockFile = ['before', '<<<<<<< HEAD', 'ours1', '=======', 'theirs1', '>>>>>>> feature', 'middle', '<<<<<<< HEAD', 'ours2', '=======', 'theirs2', '>>>>>>> feature', 'after', ''].join('\n');
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'f.txt': 'placeholder\n' } }] });
    try {
      await repo.write('f.txt', twoBlockFile);
      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: 'ours1+theirs1', rationale: 'a', confidence: 'high' }, { id: 1, resolved: 'ours2+theirs2', rationale: 'b', confidence: 'medium' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore(), tools, git);
        const result = await resolver.resolveFile(repo.path, 'f.txt', () => undefined, new AbortController().signal);
        expect(result.ok).toBe(true);
        const ranges = result.blocks.map((b) => ({ id: b.id, ...b.range }));

        const outcome = await resolver.useSideForBlock(repo.path, 'f.txt', result.original!, ranges, 1, 'theirs');
        expect(outcome.content.split('\n')).toEqual(['before', 'ours1+theirs1', 'middle', 'theirs2', 'after', '']);
        // The result covers every block's current range, including the one just overridden (needed so a
        // *second* per-block pick can still locate all blocks from the immutable `original` snapshot).
        expect(outcome.ranges.find((r) => r.id === 1)).toEqual({ id: 1, start: 3, end: 4 });
        expect(outcome.ranges.find((r) => r.id === 0)).toEqual({ id: 0, start: 1, end: 2 });

        // A second per-block pick, on the OTHER block, must still succeed using the ranges from the
        // first call's result (which include the already-overridden block's range too).
        const outcome2 = await resolver.useSideForBlock(repo.path, 'f.txt', result.original!, outcome.ranges, 0, 'ours');
        expect(outcome2.content.split('\n')).toEqual(['before', 'ours1', 'middle', 'theirs2', 'after', '']);

        // An out-of-band edit invalidates the ranges: a further call must refuse rather than silently
        // clobbering whatever is now on disk.
        await repo.write('f.txt', 'something else entirely\n');
        await expect(resolver.useSideForBlock(repo.path, 'f.txt', result.original!, ranges, 0, 'ours')).rejects.toThrow(/changed on disk/);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('resolveAllGuided sends the recorded manual example and labels the result as guided', async () => {
    // A real merge conflict on two files, so `getStatus` reports operation.kind === 'merge'
    // (examples are only kept alive while an operation is actually in progress).
    const repo: TestRepo = await createRepo({ commits: [{ message: 'base', files: { 'a.ts': 'placeholder\n', 'b.ts': 'placeholder\n' } }], branches: { feature: undefined } });
    try {
      repo.commit({ message: 'main change', files: { 'a.ts': 'main-a\n', 'b.ts': 'main-b\n' } });
      repo.git(['checkout', 'feature']);
      repo.commit({ message: 'feature change', files: { 'a.ts': 'feature-a\n', 'b.ts': 'feature-b\n' } });
      repo.git(['checkout', 'main']);
      try {
        repo.git(['merge', 'feature']);
      } catch {
        // expected: both files conflict
      }
      const bOriginal = await readFile(`${repo.path}/b.ts`, 'utf8');
      expect(bOriginal).toContain('<<<<<<<');

      const stubResponse = { is_error: false, structured_output: { resolutions: [{ id: 0, resolved: 'guided merge of a.ts', rationale: 'followed the example', confidence: 'high' }] } };
      const scenario = await createStubScenario([{ match: '-p', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = createFakeTools({ gitPath: repo.gitBin, claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const resolver = new ConflictResolver(fakeStore(), tools, git);

        // b.ts is resolved+staged by hand (out of band from the resolver), then recorded as an example.
        const manualResolved = 'manually merged\n';
        await repo.write('b.ts', manualResolved);
        repo.git(['add', 'b.ts']);
        resolver.recordExample(repo.path, 'b.ts', bOriginal, manualResolved);
        expect(await resolver.getExamplePaths(repo.path)).toEqual(['b.ts']);

        // Only a.ts is still conflicted; b.ts was already staged above.
        const results = await resolver.resolveAllGuided(repo.path, () => undefined);
        expect(results).toHaveLength(1);
        expect(results[0].path).toBe('a.ts');
        expect(results[0].ok).toBe(true);
        expect(results[0].guidedBy).toEqual(['b.ts']);
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('example paths are cleared once the operation ends (getStatus reports operation.kind === none)', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.ts': 'x\n' } }] });
    try {
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const resolver = new ConflictResolver(fakeStore(), tools, git);
      resolver.recordExample(repo.path, 'a.ts', CONFLICTED_FILE, 'resolved\n');
      // No merge/rebase/etc is in progress in this plain repo, so the operation is already 'none'.
      expect(await resolver.getExamplePaths(repo.path)).toEqual([]);
    } finally {
      await repo.dispose();
    }
  });

  it('example paths are cleared after the merge is aborted', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'base', files: { 'a.ts': 'placeholder\n' } }], branches: { feature: undefined } });
    try {
      repo.commit({ message: 'main change', files: { 'a.ts': 'main-a\n' } });
      repo.git(['checkout', 'feature']);
      repo.commit({ message: 'feature change', files: { 'a.ts': 'feature-a\n' } });
      repo.git(['checkout', 'main']);
      try {
        repo.git(['merge', 'feature']);
      } catch {
        // expected conflict
      }
      const tools = createFakeTools({ gitPath: repo.gitBin, env: repo.env });
      const git = new GitClient(tools);
      const resolver = new ConflictResolver(fakeStore(), tools, git);
      resolver.recordExample(repo.path, 'a.ts', await readFile(`${repo.path}/a.ts`, 'utf8'), 'resolved by hand\n');
      expect(await resolver.getExamplePaths(repo.path)).toEqual(['a.ts']);
      repo.git(['merge', '--abort']);
      expect(await resolver.getExamplePaths(repo.path)).toEqual([]);
    } finally {
      await repo.dispose();
    }
  });
});
