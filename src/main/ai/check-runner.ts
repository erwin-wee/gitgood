import type { PostResolveCheckResult } from '@shared/types';
import { ExecError, exec } from '../exec';

const TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export interface CheckCommandInputs {
  /** `AiSettings.postResolveCheck`. */
  userCommand: string | null;
  /** The repository's `.gitgood/config.json` `postResolveCheck`, or null when absent. */
  repoCommand: string | null;
  /** `AiSettings.postResolveCheckFromRepo`. */
  fromRepoEnabled: boolean;
  /** `Store.getRepoConfigTrust(repoPath)`: undefined (never asked) and false (declined) both refuse the repo command. */
  trusted: boolean | undefined;
}

/**
 * The trust gate: decides which check command (if any) is allowed to run,
 * without running anything itself. A repository-provided command is only
 * ever used when the setting is on AND the repository has been explicitly
 * trusted (`trusted === true`); everything else (never asked, declined, or
 * the setting off) falls back to the user's own setting, and finally to no
 * check at all. This is the single authority for "may a repo command run" —
 * callers must not run a repo command based on any other check.
 */
export function resolveCheckCommand(inputs: CheckCommandInputs): { command: string; fromRepo: boolean } | null {
  if (inputs.repoCommand && inputs.fromRepoEnabled && inputs.trusted === true) return { command: inputs.repoCommand, fromRepo: true };
  if (inputs.userCommand && inputs.userCommand.trim()) return { command: inputs.userCommand, fromRepo: false };
  return null;
}

/**
 * Runs a user- or repository-authored shell command as the post-resolution
 * check. This is the ONLY place GitGood runs a shell: check commands are
 * free-form strings (e.g. "npm run typecheck") that only make sense
 * interpreted by the platform shell. It always runs with cwd = repoPath, the
 * given (git-flavoured) environment, a 5-minute timeout (the `timeoutMs`
 * override exists only for tests), and reports only the last 4,000
 * characters of combined output.
 */
export async function runPostResolveCheck(command: string, repoPath: string, env: NodeJS.ProcessEnv, fromRepo: boolean, signal?: AbortSignal, timeoutMs: number = TIMEOUT_MS): Promise<PostResolveCheckResult> {
  const started = Date.now();
  const [file, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]];
  try {
    const result = await exec(file, args, { cwd: repoPath, env, timeoutMs, signal, maxBuffer: 8 * 1024 * 1024 });
    return { command, fromRepo, ok: true, exitCode: result.exitCode, timedOut: false, outputTail: tail(`${result.stdout}${result.stderr}`, OUTPUT_TAIL_CHARS), durationMs: Date.now() - started };
  } catch (err) {
    if (err instanceof ExecError) {
      const combined = `${err.result.stdout}${err.result.stderr}` || err.message;
      return {
        command,
        fromRepo,
        ok: false,
        exitCode: err.result.exitCode,
        timedOut: err.code === 'timeout',
        outputTail: tail(err.code === 'timeout' ? `${combined}\n(timed out after ${timeoutMs / 1000}s)` : combined, OUTPUT_TAIL_CHARS),
        durationMs: Date.now() - started,
      };
    }
    return { command, fromRepo, ok: false, exitCode: null, timedOut: false, outputTail: tail((err as Error).message ?? String(err), OUTPUT_TAIL_CHARS), durationMs: Date.now() - started };
  }
}
