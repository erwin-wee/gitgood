import { describe, expect, it } from 'vitest';
import type { AppSettings, GitErrorInfo } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { GitClient } from '../../src/main/git/git';
import { ErrorExplainService } from '../../src/main/ai/error-explain';
import { claudeLauncherPath, createStubScenario } from '../helpers/gh-stub';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';
import type { Store } from '../../src/main/store';

function fakeStore(ai: Partial<AppSettings['ai']> = {}): Store {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', ...ai } };
  return { getSettings: () => settings, getApiKey: () => null } as unknown as Store;
}

const NO_UPSTREAM_ERROR: GitErrorInfo = {
  message: 'The current branch main has no upstream branch.',
  command: 'git push',
  exitCode: 128,
  stderr: "fatal: The current branch main has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin main\n",
  stdout: '',
  code: 'no-upstream',
};

describe.skipIf(!hasGitSync())('ErrorExplainService end-to-end against the claude stub', () => {
  it('returns a validated explanation with a push-set-upstream fix, dropping an inapplicable one and downgrading an unknown action to copy-only', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'hello\n' } }] });
    try {
      const stubResponse = {
        is_error: false,
        structured_output: {
          whatHappened: 'The push was rejected because the current branch has never been published.',
          likelyCause: 'main has no upstream branch configured yet.',
          fixes: [
            { label: 'Push and set upstream', detail: 'Publish main and track it on origin.', action: 'push-set-upstream', command: null, retryAfter: true, risk: 'safe' },
            { label: 'Continue rebase', detail: 'Not applicable here.', action: 'continue-rebase', command: null, retryAfter: false, risk: 'safe' },
            { label: 'Prune remote-tracking branches', detail: 'Removes stale remote-tracking refs.', action: 'prune-remote-tracking', command: 'git fetch --prune', retryAfter: false, risk: 'safe' },
          ],
        },
      };
      const scenario = await createStubScenario([{ match: 'You explain a failed git or GitHub CLI command', stdout: JSON.stringify(stubResponse) }]);
      try {
        const tools = repo.tools({ claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ErrorExplainService(fakeStore(), tools, git);
        const explanation = await service.explainError(repo.path, NO_UPSTREAM_ERROR, true);

        expect(explanation.whatHappened).toContain('never been published');
        expect(explanation.model).toBeTruthy();
        // The inapplicable continue-rebase fix (no rebase in progress) is dropped.
        expect(explanation.fixes.some((f) => f.action === 'continue-rebase')).toBe(false);
        // The known, applicable action fix survives, and retryAfter is honoured since the call passed retryable=true.
        const publish = explanation.fixes.find((f) => f.action === 'push-set-upstream');
        expect(publish).toBeTruthy();
        expect(publish!.risk).toBe('touches-remote'); // raised from the model's "safe" to the action map's own classification
        expect(publish!.retryAfter).toBe(true);
        // The unknown action with a safe command downgrades to copy-only rather than being dropped.
        const pruneFix = explanation.fixes.find((f) => f.command === 'git fetch --prune');
        expect(pruneFix).toBeTruthy();
        expect(pruneFix!.action).toBeNull();
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });

  it('never sends the raw stderr containing a token to the model (only its scrubbed form)', async () => {
    const repo: TestRepo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'hello\n' } }] });
    try {
      const authError: GitErrorInfo = {
        message: 'Authentication failed',
        command: 'git fetch',
        exitCode: 128,
        stderr: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://ghp_1234567890abcdefghij1234567890ABCD@github.com/org/repo.git/'\n",
        stdout: '',
        code: 'auth-failed',
      };
      // No canned JSON this time: the stub echoes back exactly what it received on stdin (the
      // prompt built from `authError`), so the backend fails to parse it as JSON and the resulting
      // error message (which includes the first 300 chars of that raw prompt) lets us inspect
      // exactly what left the process — proving the scrub happened before the backend call, not
      // relying on any instrumentation of the prompt-building code itself.
      const scenario = await createStubScenario([{ match: 'You explain a failed git or GitHub CLI command', stdoutFromStdin: true }]);
      try {
        const tools = repo.tools({ claudePath: claudeLauncherPath(), env: { ...repo.env, ...scenario.env('CLAUDE') } });
        const git = new GitClient(tools);
        const service = new ErrorExplainService(fakeStore(), tools, git);
        let message = '';
        try {
          await service.explainError(repo.path, authError, false);
          throw new Error('expected explainError to reject (the stub does not return valid structured output)');
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).not.toContain('1234567890abcdefghij');
        expect(message).toContain('ghp_***');
      } finally {
        await scenario.dispose();
      }
    } finally {
      await repo.dispose();
    }
  });
});
