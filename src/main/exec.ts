import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Maximum captured output in bytes (default 64 MB). */
  maxBuffer?: number;
  /** Exit codes other than 0 that should not be treated as failure. */
  okExitCodes?: number[];
}

export interface ExecResult {
  command: string;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

export class ExecError extends Error {
  readonly result: ExecResult;
  readonly code: string | null;
  constructor(message: string, result: ExecResult, code: string | null = null) {
    super(message);
    this.name = 'ExecError';
    this.result = result;
    this.code = code;
  }
}

export function formatCommand(file: string, args: string[]): string {
  const quote = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [file, ...args].map(quote).join(' ');
}

/**
 * Spawns a process (never through a shell) and collects its output.
 * Rejects with ExecError on non-zero exit, spawn failure, timeout or abort.
 */
export function exec(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const command = formatCommand(file, args);
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ExecError(`Failed to start ${file}: ${(err as Error).message}`, emptyResult(command), 'spawn-failed'));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdoutChunks.push(chunk);
      if (opts.onStdout) opts.onStdout(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderrChunks.push(chunk);
      if (opts.onStderr) opts.onStderr(chunk.toString('utf8'));
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        const result = emptyResult(command);
        const code = err.code === 'ENOENT' ? 'not-found' : 'spawn-failed';
        reject(new ExecError(`Failed to run ${file}: ${err.message}`, result, code));
      });
    });
    child.on('close', (exitCode, signal) => {
      finish(() => {
        const stdoutBuffer = Buffer.concat(stdoutChunks);
        const result: ExecResult = {
          command,
          stdout: stdoutBuffer.toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutBuffer,
          exitCode,
          signal,
          timedOut,
          aborted,
        };
        if (aborted) {
          reject(new ExecError('Operation cancelled', result, 'aborted'));
          return;
        }
        if (timedOut) {
          reject(new ExecError(`${file} timed out after ${opts.timeoutMs} ms`, result, 'timeout'));
          return;
        }
        if (exitCode === 0 || (exitCode !== null && opts.okExitCodes?.includes(exitCode))) {
          resolve(result);
          return;
        }
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${exitCode}`;
        reject(new ExecError(detail, result, 'non-zero-exit'));
      });
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE when the process exits early; the close handler reports it */
      });
      child.stdin.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function emptyResult(command: string): ExecResult {
  return { command, stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0), exitCode: null, signal: null, timedOut: false, aborted: false };
}

/** Spawns a detached process (e.g. an editor) and forgets about it. */
export function launchDetached(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; verbatim?: boolean; detached?: boolean; hide?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: opts.detached ?? true,
        stdio: 'ignore',
        windowsHide: opts.hide ?? false,
        shell: opts.shell ?? false,
        windowsVerbatimArguments: opts.verbatim ?? false,
      });
      child.on('error', (err) => reject(new ExecError(`Failed to launch ${file}: ${err.message}`, emptyResult(formatCommand(file, args)), 'spawn-failed')));
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Windows: opens a program in a new window via `start`, which is the only
 * reliable way to get a visible console for cmd/PowerShell from a GUI process
 * (a detached spawn would create the console hidden). `command` is a list of
 * pre-quoted tokens.
 */
export function startOnWindows(tokens: string[], cwd?: string): Promise<void> {
  const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
  const command = `start "" ${cwd ? `/D ${cmdQuote(cwd)} ` : ''}${tokens.join(' ')}`;
  return launchDetached(comspec, ['/d', '/s', '/c', `"${command}"`], { cwd, verbatim: true, detached: false, hide: true });
}

export { cmdQuote };
