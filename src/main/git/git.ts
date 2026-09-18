import type { GitErrorInfo } from '@shared/types';
import { ExecError, exec, type ExecOptions, type ExecResult } from '../exec';
import { log } from '../logger';
import type { ToolLocator } from '../tools';

export class GitError extends Error {
  readonly info: GitErrorInfo;
  constructor(info: GitErrorInfo) {
    super(info.message);
    this.name = 'GitError';
    this.info = info;
  }
}

export function classifyGitError(stderr: string, stdout: string): GitErrorInfo['code'] {
  const text = `${stderr}\n${stdout}`;
  const tests: [RegExp, GitErrorInfo['code']][] = [
    [/not a git repository/i, 'not-a-repository'],
    // Checked before the more generic "signing failed" pattern below, since git's own
    // "error: gpg failed to sign the data" / "fatal: failed to write commit object" wrapper
    // lines accompany both a missing key and other signing failures.
    [/No secret key|secret key not available|No default secret key|ssh-keygen: .* No such file or directory|Load key ".*": No such file or directory/i, 'signing-key-missing'],
    [/gpg failed to sign the data|error: gpg failed to sign|unable to sign the tag/i, 'signing-failed'],
    [/Authentication failed|could not read Username|Permission denied \(publickey\)|Invalid username or (password|token)|HTTP 401|fatal: Authentication|terminal prompts disabled|remote: Support for password authentication|The requested URL returned error: 403/i, 'auth-failed'],
    [/protected branch hook declined|GH006|GH013|refusing to allow|remote: error: Required status check/i, 'protected-branch'],
    [/\[rejected\][^\n]*(non-fast-forward|fetch first|stale info|needs force)|Updates were rejected|failed to push some refs/i, 'non-fast-forward'],
    [/Could not resolve host|unable to access|Connection timed out|Network is unreachable|Failed to connect|Could not read from remote repository|Connection refused|Recv failure|SSL_ERROR|TLS handshake|Operation timed out/i, 'network'],
    [/CONFLICT \(|Automatic merge failed|could not apply|Resolve all conflicts manually|fix conflicts and then|You have unmerged paths|needs merge|Committing is not possible because you have unmerged files/i, 'conflicts'],
    [/Your local changes to the following files would be overwritten|Please commit your changes or stash them|The following untracked working tree files would be overwritten|would be overwritten by (checkout|merge)/i, 'local-changes-overwritten'],
    [/has no upstream branch|no tracking information|There is no tracking information/i, 'no-upstream'],
    [/nothing to commit|nothing added to commit|no changes added to commit/i, 'nothing-to-commit'],
    [/Unable to create '.*\.lock'|Another git process seems to be running|index\.lock': File exists/i, 'lock-file'],
    [/Repository not found|remote: Not Found|does not appear to be a git repository|Could not find remote branch|No such remote|Please make sure you have the correct access rights/i, 'remote-not-found'],
    [/is already (?:checked out|used by worktree) at/i, 'worktree-branch-in-use'],
    [/already exists/i, 'branch-exists'],
  ];
  for (const [re, code] of tests) if (re.test(text)) return code;
  return 'unknown';
}

export function toGitErrorInfo(err: unknown, command = ''): GitErrorInfo {
  if (err instanceof GitError) return err.info;
  if (err instanceof ExecError) {
    const r = err.result;
    const code: GitErrorInfo['code'] = err.code === 'not-found' ? 'tool-missing' : err.code === 'aborted' ? 'cancelled' : classifyGitError(r.stderr, r.stdout);
    return {
      message: err.message,
      command: r.command || command,
      exitCode: r.exitCode,
      stderr: r.stderr,
      stdout: r.stdout,
      code,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message, command, exitCode: null, stderr: '', stdout: '', code: /not found|was not found/i.test(message) ? 'tool-missing' : 'unknown' };
}

export interface GitRunOptions {
  stdin?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  okExitCodes?: number[];
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Set to true for read-only commands to avoid taking optional locks. */
  readOnly?: boolean;
  /** Suppress failure logging (used for probing commands that are expected to fail). */
  quiet?: boolean;
}

export class GitClient {
  constructor(private readonly tools: ToolLocator) {}

  async baseEnv(extra?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...(await this.tools.env()) };
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_PAGER = 'cat';
    env.PAGER = 'cat';
    env.LC_ALL = 'C';
    env.LANG = 'C';
    env.GIT_FLUSH = '1';
    if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    return { ...env, ...(extra ?? {}) };
  }

  /**
   * Runs git in the given repository. Throws GitError on failure.
   */
  async run(repoPath: string | null, args: string[], opts: GitRunOptions = {}): Promise<ExecResult> {
    await this.tools.ensureLocated();
    const gitPath = this.tools.gitPath();
    const env = await this.baseEnv(opts.env);
    if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
    const fullArgs = ['-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'advice.detachedHead=false'];
    if (process.platform === 'win32') fullArgs.push('-c', 'core.longpaths=true');
    fullArgs.push('--no-pager', ...args);
    const execOpts: ExecOptions = {
      cwd: repoPath ?? undefined,
      env,
      stdin: opts.stdin,
      okExitCodes: opts.okExitCodes,
      signal: opts.signal,
      onStderr: opts.onStderr,
      onStdout: opts.onStdout,
      timeoutMs: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
    };
    const started = Date.now();
    try {
      const result = await exec(gitPath, fullArgs, execOpts);
      const ms = Date.now() - started;
      if (ms > 2000) log.info(`git ${args[0]} took ${ms}ms (${repoPath ?? ''})`);
      return result;
    } catch (err) {
      const info = toGitErrorInfo(err, `git ${args.join(' ')}`);
      if (info.code !== 'cancelled' && !opts.quiet) log.warn(`git ${args.join(' ')} failed: ${info.message.split('\n')[0]}`);
      throw new GitError(info);
    }
  }

  /** Like run() but resolves to null instead of throwing. */
  async tryRun(repoPath: string | null, args: string[], opts: GitRunOptions = {}): Promise<ExecResult | null> {
    try {
      return await this.run(repoPath, args, { ...opts, quiet: true });
    } catch {
      return null;
    }
  }

  async stdout(repoPath: string | null, args: string[], opts: GitRunOptions = {}): Promise<string> {
    return (await this.run(repoPath, args, opts)).stdout;
  }
}

/**
 * Parses git's transfer progress output into a 0..1 fraction, weighting the
 * phases the way GitHub Desktop does.
 */
export class TransferProgressParser {
  private readonly phases: Record<string, { weight: number; value: number }>;
  private readonly order: string[];
  constructor(kind: 'fetch' | 'push') {
    if (kind === 'push') {
      this.order = ['Enumerating objects', 'Counting objects', 'Compressing objects', 'Writing objects'];
      this.phases = {
        'Enumerating objects': { weight: 0.05, value: 0 },
        'Counting objects': { weight: 0.05, value: 0 },
        'Compressing objects': { weight: 0.2, value: 0 },
        'Writing objects': { weight: 0.7, value: 0 },
      };
    } else {
      this.order = ['remote: Enumerating objects', 'remote: Counting objects', 'remote: Compressing objects', 'Receiving objects', 'Resolving deltas', 'Updating files', 'Checking out files'];
      this.phases = {
        'remote: Enumerating objects': { weight: 0.02, value: 0 },
        'remote: Counting objects': { weight: 0.03, value: 0 },
        'remote: Compressing objects': { weight: 0.05, value: 0 },
        'Receiving objects': { weight: 0.6, value: 0 },
        'Resolving deltas': { weight: 0.15, value: 0 },
        'Updating files': { weight: 0.15, value: 0 },
        'Checking out files': { weight: 0, value: 0 },
      };
    }
  }

  /** Feed a chunk of stderr; returns latest {percent, description} if progress was recognized. */
  feed(chunk: string): { percent: number; description: string } | null {
    let latest: { percent: number; description: string } | null = null;
    for (const line of chunk.split(/[\r\n]+/)) {
      const m = /^(remote: )?([A-Za-z ]+?):\s+(\d+)%/.exec(line.trim());
      if (!m) continue;
      const key = `${m[1] ?? ''}${m[2]}`;
      const pct = parseInt(m[3], 10) / 100;
      const phase = this.phases[key] ?? this.phases[m[2]];
      if (!phase) continue;
      phase.value = Math.max(phase.value, pct);
      // Earlier phases are complete once a later phase reports.
      const idx = this.order.indexOf(key in this.phases ? key : m[2]);
      for (let i = 0; i < idx; i++) this.phases[this.order[i]].value = 1;
      let total = 0;
      let weightSum = 0;
      for (const name of this.order) {
        total += this.phases[name].weight * this.phases[name].value;
        weightSum += this.phases[name].weight;
      }
      latest = { percent: Math.min(1, total / (weightSum || 1)), description: line.trim().replace(/^remote:\s*/, '') };
    }
    return latest;
  }
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
