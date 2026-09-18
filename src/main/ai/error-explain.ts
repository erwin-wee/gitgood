/**
 * AI error explanation: turns a classified (or unclassified) git/gh failure
 * into a plain-language explanation plus up to three fixes drawn from the
 * fixed action map in fixActions.ts. Mirrors the split used by
 * review.ts/review-core.ts and explain.ts/explain-core.ts: orchestration
 * here (gathering repository context, calling the backend), pure validation
 * in error-explain-core.ts. Never runs a suggested fix itself — the
 * renderer dispatches action fixes to its own action functions and their
 * confirmations (see applyErrorFix in src/renderer/src/state/actions.ts).
 */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ErrorExplanation, GitErrorInfo } from '@shared/types';
import { exec } from '../exec';
import { FIX_ACTIONS } from './fixActions';
import type { GitClient } from '../git/git';
import { getRemotes } from '../git/operations';
import { getGitDir, getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { createBackend } from './provider';
import { buildErrorExplainPrompt, ERROR_EXPLAIN_SCHEMA, ERROR_EXPLAIN_SYSTEM_PROMPT, type ErrorExplainRemote } from './prompts';
import { checkLockFileGuard, extractRemoteHost, scrubAndTail, validateErrorExplanation } from './error-explain-core';

const REFLOG_LINES = 10;
const MAX_REMOTES = 10;

export class ErrorExplainService {
  private controller: AbortController | null = null;

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while an explanation request is in flight; used by the update install gate alongside the other AI services. */
  isActive(): boolean {
    return this.controller !== null;
  }

  async explainError(repoPath: string | null, error: GitErrorInfo, retryable: boolean): Promise<ErrorExplanation> {
    const { backend, settings } = await createBackend(this.store, this.tools);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const hasRepo = repoPath !== null;
      const status = repoPath ? await getStatus(this.git, repoPath).catch(() => null) : null;

      let remotes: ErrorExplainRemote[] = [];
      let reflog: string[] = [];
      if (repoPath) {
        const [remoteList, reflogOut] = await Promise.all([
          getRemotes(this.git, repoPath).catch(() => []),
          this.git.tryRun(repoPath, ['reflog', '--format=%h %gs', '-n', String(REFLOG_LINES)], { readOnly: true }),
        ]);
        remotes = remoteList.slice(0, MAX_REMOTES).map((r) => ({ name: r.name, host: extractRemoteHost(r.fetchUrl || r.pushUrl) }));
        reflog = reflogOut ? scrubAndTail(reflogOut.stdout, 2000).split('\n').filter(Boolean) : [];
      }

      const tools = this.tools.current();
      const availableActions = FIX_ACTIONS.filter((a) => a.appliesTo(status, hasRepo));

      const prompt = buildErrorExplainPrompt({
        code: error.code,
        command: error.command,
        exitCode: error.exitCode,
        stderrTail: scrubAndTail(error.stderr),
        stdoutTail: scrubAndTail(error.stdout),
        retryable,
        hasRepo,
        branch: status ? { name: status.branch.name, upstream: status.branch.upstream, ahead: status.branch.ahead, behind: status.branch.behind, detached: status.branch.detached, unborn: status.branch.unborn, upstreamGone: status.branch.upstreamGone } : null,
        operationKind: status?.operation.kind ?? null,
        changedFilesCount: status ? status.files.length : null,
        conflictedFilesCount: status ? status.files.filter((f) => f.conflict !== null).length : null,
        remotes,
        reflog,
        platform: process.platform,
        gitVersion: tools.git.version,
        ghVersion: tools.gh.installed ? tools.gh.version : null,
        availableActions,
      });

      const response = await backend.complete({
        system: ERROR_EXPLAIN_SYSTEM_PROMPT,
        prompt,
        schema: ERROR_EXPLAIN_SCHEMA as unknown as Record<string, unknown>,
        model: settings.model,
        effort: settings.effort === 'max' ? 'high' : settings.effort,
        signal: controller.signal,
      });
      const explanation = validateErrorExplanation(response.json, response.model, status, hasRepo, retryable);
      if (!explanation) throw new AiError('The model returned an unusable explanation. Try again.', 'invalid-output');
      log.info(`AI error explanation for code "${error.code}" via ${backend.name}/${explanation.model}: ${explanation.fixes.length} fix(es) kept`);
      return explanation;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /**
   * Removes a stale `.git/index.lock`, refusing when a `git` process appears
   * to be running or the lock is younger than 10 seconds. This deletion is
   * the only filesystem write this feature performs, and it always runs
   * behind the renderer's confirmation dialog.
   */
  async removeLockFile(repoPath: string): Promise<{ removed: boolean; reason: string | null }> {
    const gitDir = await getGitDir(this.git, repoPath);
    const lockPath = join(gitDir, 'index.lock');
    let lockAgeMs: number | null = null;
    try {
      const info = await stat(lockPath);
      lockAgeMs = Date.now() - info.mtimeMs;
    } catch {
      lockAgeMs = null;
    }
    const gitProcessRunning = await isGitProcessRunning();
    const guard = checkLockFileGuard({ gitProcessRunning, lockAgeMs });
    if (!guard.safe) return { removed: false, reason: guard.reason };
    try {
      await rm(lockPath, { force: true });
    } catch (err) {
      return { removed: false, reason: `Could not remove the lock file: ${(err as Error).message}` };
    }
    log.info(`Removed stale lock file at ${lockPath}`);
    return { removed: true, reason: null };
  }
}

/** Checks for a running `git` process via `pgrep`/`tasklist`, never through a shell. Fails safe: if the check itself cannot run, a process is assumed to be running. */
async function isGitProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const res = await exec('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'], { timeoutMs: 5000, okExitCodes: [0, 1] });
      return /git\.exe/i.test(res.stdout);
    }
    const res = await exec('pgrep', ['-x', 'git'], { timeoutMs: 5000, okExitCodes: [0, 1] });
    return res.stdout.trim().length > 0;
  } catch {
    return true;
  }
}
