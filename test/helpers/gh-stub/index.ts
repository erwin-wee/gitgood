import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory containing the `gh`/`gh.cmd`/`claude`/`claude.cmd` launchers and the shared engine. */
export const GH_STUB_DIR = dirname(fileURLToPath(import.meta.url));

export interface StubMatch {
  regex: string;
}

export interface StubRule {
  /** A substring, list of substrings (all must appear) or {regex} tested against the joined argv. Omit to match anything. */
  match?: string | string[] | StubMatch;
  /** Written verbatim to stdout (strings are written as-is; other values are JSON-stringified). */
  stdout?: string | unknown;
  /** When true, ignore `stdout` and echo stdin back out (used to inspect what a caller sent). */
  stdoutFromStdin?: boolean;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  /** Label recorded in the invocation log instead of the raw argv. */
  name?: string;
}

export type StubPrefix = 'GH' | 'CLAUDE' | 'GPG' | 'SSH_KEYGEN';

export interface StubScenario {
  scenarioPath: string;
  logPath: string;
  dir: string;
  /** Env vars to merge into a ToolLocator's env() so the launcher can find the scenario/log. */
  env(prefix: StubPrefix): NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export interface StubInvocation {
  tool: string;
  args: string[];
  cwd: string;
  at: string;
  matched: boolean;
  rule?: string;
  reason?: string;
}

/** Writes a fresh scenario file and empty log file under a new temp directory. */
export async function createStubScenario(rules: StubRule[]): Promise<StubScenario> {
  const dir = await mkdtemp(join(tmpdir(), 'gg-stub-'));
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'log.ndjson');
  await writeFile(scenarioPath, JSON.stringify({ rules }, null, 2), 'utf8');
  await writeFile(logPath, '', 'utf8');
  return {
    scenarioPath,
    logPath,
    dir,
    env(prefix) {
      return { [`${prefix}_STUB_SCENARIO`]: scenarioPath, [`${prefix}_STUB_LOG`]: logPath };
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Reads and parses every ndjson line the stub has logged so far. */
export async function readStubLog(logPath: string): Promise<StubInvocation[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubInvocation);
}

export function ghLauncherPath(): string {
  return join(GH_STUB_DIR, process.platform === 'win32' ? 'gh.cmd' : 'gh');
}

export function claudeLauncherPath(): string {
  return join(GH_STUB_DIR, process.platform === 'win32' ? 'claude.cmd' : 'claude');
}

export function gpgLauncherPath(): string {
  return join(GH_STUB_DIR, process.platform === 'win32' ? 'gpg.cmd' : 'gpg');
}

export function sshKeygenLauncherPath(): string {
  return join(GH_STUB_DIR, process.platform === 'win32' ? 'ssh-keygen.cmd' : 'ssh-keygen');
}
