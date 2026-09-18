import type { GitHubAccount, ToolsState } from '../../src/shared/types';
import type { ToolLocator } from '../../src/main/tools';

export interface FakeToolsOptions {
  gitPath?: string | null;
  ghPath?: string | null;
  claudePath?: string | null;
  gitLfsPath?: string | null;
  gpgPath?: string | null;
  sshKeygenPath?: string | null;
  /** Extra environment variables merged on top of process.env for env()/ghEnv(). */
  env?: NodeJS.ProcessEnv;
  ghAccount?: GitHubAccount | null;
}

/**
 * A minimal stand-in for `ToolLocator` that satisfies what `GitClient`,
 * `GhClient` and the AI backends need, without touching real settings,
 * Electron or PATH discovery. Cast through `unknown` because `ToolLocator`
 * is a concrete class with private members that a plain object can never
 * structurally match.
 */
export function createFakeTools(opts: FakeToolsOptions = {}): ToolLocator {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const state: ToolsState = {
    git: { installed: !!opts.gitPath, version: 'test', path: opts.gitPath ?? null, error: opts.gitPath ? null : 'git not configured in fake tools' },
    gh: { installed: !!opts.ghPath, version: 'test', path: opts.ghPath ?? null, error: opts.ghPath ? null : 'gh not configured in fake tools' },
    claudeCli: { installed: !!opts.claudePath, version: 'test', path: opts.claudePath ?? null, error: null },
    gitLfs: { installed: !!opts.gitLfsPath, version: 'test', path: opts.gitLfsPath ?? null, error: opts.gitLfsPath ? null : 'git-lfs not configured in fake tools' },
    gpg: { installed: !!opts.gpgPath, version: 'test', path: opts.gpgPath ?? null, error: opts.gpgPath ? null : 'gpg not configured in fake tools' },
    sshKeygen: { installed: !!opts.sshKeygenPath, version: null, path: opts.sshKeygenPath ?? null, error: opts.sshKeygenPath ? null : 'ssh-keygen not configured in fake tools' },
    ghAccount: opts.ghAccount ?? null,
    ghAuthError: null,
    credentialHelperConfigured: false,
  };
  const fake = {
    async env(): Promise<NodeJS.ProcessEnv> {
      return env;
    },
    async ghEnv(): Promise<NodeJS.ProcessEnv> {
      const e: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat', PAGER: 'cat' };
      delete e.GH_FORCE_TTY;
      delete e.CLICOLOR_FORCE;
      return e;
    },
    current(): ToolsState {
      return state;
    },
    async ensureLocated(): Promise<void> {},
    async refresh(): Promise<ToolsState> {
      return state;
    },
    gitPath(): string {
      if (!opts.gitPath) throw new Error('Git was not found (fake tools).');
      return opts.gitPath;
    },
    ghPath(): string {
      if (!opts.ghPath) throw new Error('GitHub CLI (gh) was not found (fake tools).');
      return opts.ghPath;
    },
    claudePath(): string | null {
      return opts.claudePath ?? null;
    },
  };
  return fake as unknown as ToolLocator;
}
