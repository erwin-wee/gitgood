import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, normalize } from 'node:path';
import type { GhAccountEntry, GitHubAccount, RepositoryInfo, ToolInfo, ToolsState } from '@shared/types';
import { compareVersions, MIN_TOOL_VERSIONS } from '@shared/util';
import { repoScope } from './core/client-context';
import { exec } from './exec';
import { parseGhAuthStatus, primaryAccount } from './gh/accounts';
import { GitError } from './git/git';
import { log } from './logger';
import type { Store } from './store';

/** Marks `info` outdated (with the minimum) when its version is known and below `min`; never blocks. */
export function flagOutdated(info: ToolInfo, min: string): ToolInfo {
  if (!info.installed || !info.version) return info;
  return compareVersions(info.version, min) < 0 ? { ...info, outdated: true, minVersion: min } : info;
}

const isWindows = process.platform === 'win32';

async function isExecutable(file: string): Promise<boolean> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    if (isWindows) return true;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatesFor(name: string): string[] {
  if (!isWindows) return [name];
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const out = [name];
  for (const ext of exts) out.push(name + ext.toLowerCase());
  return out;
}

function knownDirs(tool: 'git' | 'gh' | 'claude' | 'gpg' | 'sshKeygen'): string[] {
  const home = homedir();
  const dirs: string[] = [];
  if (isWindows) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programData = process.env.ProgramData ?? 'C:\\ProgramData';
    if (tool === 'git') {
      dirs.push(join(pf, 'Git', 'cmd'), join(pf, 'Git', 'bin'), join(pf86, 'Git', 'cmd'), join(local, 'Programs', 'Git', 'cmd'));
    } else if (tool === 'gh') {
      dirs.push(join(pf, 'GitHub CLI'), join(pf86, 'GitHub CLI'), join(local, 'Programs', 'GitHub CLI'));
    } else if (tool === 'gpg') {
      dirs.push(join(pf, 'GnuPG', 'bin'), join(pf86, 'GnuPG', 'bin'), join(pf, 'Git', 'usr', 'bin'));
    } else if (tool === 'sshKeygen') {
      dirs.push('C:\\Windows\\System32\\OpenSSH', join(pf, 'Git', 'usr', 'bin'));
    } else {
      dirs.push(join(home, '.local', 'bin'), join(local, 'Programs', 'claude'));
    }
    dirs.push(join(local, 'Microsoft', 'WinGet', 'Links'), join(home, 'scoop', 'shims'), join(programData, 'chocolatey', 'bin'));
  } else if (process.platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.local', 'bin'), '/opt/local/bin');
    if (tool === 'git') dirs.push('/Library/Developer/CommandLineTools/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/bin');
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/bin', join(home, '.local', 'bin'), '/snap/bin', join(home, '.local', 'share', 'mise', 'shims'), '/home/linuxbrew/.linuxbrew/bin');
  }
  return dirs;
}

export async function findExecutable(name: string, extraDirs: string[], pathEnv: string | undefined): Promise<string | null> {
  const dirs = [...(pathEnv ?? '').split(delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    for (const candidate of candidatesFor(name)) {
      const full = join(dir, candidate);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

async function loginShellPath(): Promise<string | null> {
  if (isWindows) return null;
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    const isFish = /fish$/.test(shell);
    const cmd = isFish ? 'string join ":" $PATH' : 'echo "$PATH"';
    const result = await exec(shell, ['-lc', cmd], { timeoutMs: 4000 });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last.includes('/')) return last.trim();
  } catch (err) {
    log.warn(`Could not read PATH from login shell: ${(err as Error).message}`);
  }
  return null;
}

type ProbeKey = 'git' | 'gh' | 'claudeCli' | 'gitLfs' | 'gpg' | 'sshKeygen';
type Probes = Record<ProbeKey, Promise<ToolInfo>>;

const PENDING: ToolInfo = { installed: false, version: null, path: null, error: null, pending: true };
const samePath = (a: string, b: string): boolean => (isWindows ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b));

export class ToolLocator {
  private state: ToolsState = {
    git: { ...PENDING },
    gh: { ...PENDING },
    claudeCli: { ...PENDING },
    gitLfs: { ...PENDING },
    gpg: { ...PENDING },
    sshKeygen: { ...PENDING },
    ghAccount: null,
    ghAccounts: [],
    ghAuthError: null,
    credentialHelperConfigured: false,
  };
  /** One shared login-shell PATH lookup; concurrent probes await the same promise. */
  private envPromise: Promise<NodeJS.ProcessEnv> | null = null;
  private probes: Probes | null = null;
  private refreshing: Promise<ToolsState> | null = null;
  private readonly listeners = new Set<(state: ToolsState) => void>();
  /** In-memory only: `host\0login` → token from `gh auth token --user`. Never logged, persisted or exported. */
  private readonly accountTokens = new Map<string, Promise<string>>();

  constructor(private readonly store: Store) {}

  /** The repository whose machine-local policy governs a path; the entry points swap in `RepositoryManager.policyRepo` so linked worktrees follow their main repository. */
  policyRepo: (repoPath: string) => Promise<RepositoryInfo | null> = async (repoPath) => this.store.getRepositories().find((r) => samePath(r.path, repoPath)) ?? null;

  /** Called with the new state whenever a probe or the auth read settles (renderers get it as `tools.changed`). */
  onChange(listener: (state: ToolsState) => void): void {
    this.listeners.add(listener);
  }

  private patch(patch: Partial<ToolsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** process.env augmented with the user's login-shell PATH (mac/Linux GUI launches have a minimal PATH). */
  env(): Promise<NodeJS.ProcessEnv> {
    this.envPromise ??= (async () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      const shellPath = await loginShellPath();
      if (shellPath) {
        const merged = new Set([...shellPath.split(delimiter), ...(env.PATH ?? '').split(delimiter)]);
        env.PATH = [...merged].filter(Boolean).join(delimiter);
      }
      return env;
    })();
    return this.envPromise;
  }

  current(): ToolsState {
    return this.state;
  }

  gitPath(): string {
    if (!this.state.git.path) throw new Error('Git was not found. Install Git for Windows (https://git-scm.com) or set its location in Options → Advanced.');
    return this.state.git.path;
  }

  ghPath(): string {
    if (!this.state.gh.path) throw new Error('GitHub CLI (gh) was not found. Install it from https://cli.github.com or set its location in Options → Advanced.');
    return this.state.gh.path;
  }

  claudePath(): string | null {
    return this.state.claudeCli.path;
  }

  /**
   * Starts every probe at once (no network; a slow one never delays another). Each probe updates the
   * state when it settles; a restart (`refresh`) makes results of the previous round discard themselves.
   */
  private startProbes(): Probes {
    if (this.probes) return this.probes;
    const settings = this.store.getSettings();
    const mine = {} as Probes;
    this.probes = mine;
    const track = (key: ProbeKey, probe: Promise<ToolInfo>): void => {
      mine[key] = probe.then((info) => {
        if (this.probes === mine) this.patch({ [key]: info });
        return info;
      });
    };
    track('git', this.locate('git', settings.gitPath, ['--version'], (o) => /git version (\S+)/.exec(o)?.[1] ?? null).then((i) => flagOutdated(i, MIN_TOOL_VERSIONS.git)));
    track('gh', this.locate('gh', settings.ghPath, ['--version'], (o) => /gh version (\S+)/.exec(o)?.[1] ?? null).then((i) => flagOutdated(i, MIN_TOOL_VERSIONS.gh)));
    track('claudeCli', this.locate('claude', settings.ai.claudeCliPath, ['--version'], (o) => o.trim().split('\n')[0]?.trim() || null));
    track('gpg', this.locate('gpg', null, ['--version'], (o) => /gpg \(GnuPG\) (\S+)/.exec(o)?.[1] ?? null));
    track('sshKeygen', this.locateSshKeygen());
    track('gitLfs', mine.git.then((git) => this.locateLfs(git)));
    return mine;
  }

  /** Resolves with that tool's info once its probe has finished; git commands wait for the git probe only, never for gh/claude/gpg. */
  ensure(key: ProbeKey): Promise<ToolInfo> {
    return this.startProbes()[key];
  }

  /**
   * ssh-keygen has no reliable `--version`/`-V` flag that only prints a
   * version (some invocations would instead perform key operations), so this
   * only confirms presence on PATH without executing it.
   */
  private async locateSshKeygen(): Promise<ToolInfo> {
    const env = await this.env();
    const path = await findExecutable('ssh-keygen', knownDirs('sshKeygen'), env.PATH);
    if (!path) return { installed: false, version: null, path: null, error: 'ssh-keygen not found on PATH' };
    return { installed: true, version: null, path, error: null };
  }

  /**
   * Locates git-lfs, preferring `git lfs version` (the subcommand git itself
   * resolves) and falling back to a standalone `git-lfs` binary on PATH so
   * the app can still detect an installation that predates git's plugin
   * discovery, or one installed outside git's exec-path.
   */
  private async locateLfs(git: ToolInfo): Promise<ToolInfo> {
    const env = await this.env();
    const parse = (out: string): string | null => /git-lfs\/(\S+)/.exec(out)?.[1] ?? null;
    if (git.installed && git.path) {
      try {
        const result = await exec(git.path, ['lfs', 'version'], { env, timeoutMs: 10000 });
        return { installed: true, version: parse(result.stdout + result.stderr), path: git.path, error: null };
      } catch {
        /* git has no lfs subcommand installed; fall back to a standalone binary */
      }
    }
    const path = await findExecutable('git-lfs', [], env.PATH);
    if (!path) return { installed: false, version: null, path: null, error: 'git-lfs not found' };
    try {
      const result = await exec(path, ['version'], { env, timeoutMs: 10000 });
      return { installed: true, version: parse(result.stdout + result.stderr), path, error: null };
    } catch (err) {
      return { installed: false, version: null, path, error: (err as Error).message };
    }
  }

  /** Re-probes every tool (settings changed, Setup "re-check") and re-reads the gh sign-in state. */
  refresh(): Promise<ToolsState> {
    if (this.refreshing) return this.refreshing;
    this.probes = null;
    this.refreshing = this.readAuth().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Re-reads only the gh sign-in state (accounts, credential helper); tool probes stay as they are. */
  refreshAuth(): Promise<ToolsState> {
    return this.readAuth();
  }

  private async locate(tool: 'git' | 'gh' | 'claude' | 'gpg' | 'sshKeygen', override: string | null, versionArgs: string[], parse: (out: string) => string | null): Promise<ToolInfo> {
    const env = await this.env();
    let path: string | null = null;
    if (override) {
      path = (await isExecutable(override)) ? override : null;
      if (!path) return { installed: false, version: null, path: null, error: `Configured path does not exist: ${override}` };
    } else {
      path = await findExecutable(tool, knownDirs(tool), env.PATH);
    }
    if (!path) return { installed: false, version: null, path: null, error: `${tool} not found on PATH` };
    try {
      const result = await exec(path, versionArgs, { env, timeoutMs: 15000 });
      return { installed: true, version: parse(result.stdout + result.stderr), path, error: null };
    } catch (err) {
      return { installed: false, version: null, path, error: (err as Error).message };
    }
  }

  private async readAuth(): Promise<ToolsState> {
    this.accountTokens.clear();
    const { git, gh } = this.startProbes();
    const [gitInfo, ghInfo] = await Promise.all([git, gh]);
    const auth = ghInfo.installed && ghInfo.path ? await this.readGhAuth(ghInfo.path) : { accounts: [], account: null, error: null };
    const credentialHelperConfigured = gitInfo.installed && gitInfo.path ? await this.checkCredentialHelper(gitInfo.path) : false;
    this.patch({ ghAccount: auth.account, ghAccounts: auth.accounts, ghAuthError: auth.error, credentialHelperConfigured });
    return this.state;
  }

  private async readGhAuth(ghPath: string): Promise<{ accounts: GhAccountEntry[]; account: GitHubAccount | null; error: string | null }> {
    const env = await this.ghEnv();
    const none = { accounts: [], account: null };
    try {
      // `--json hosts` needs gh 2.67+; older gh fails with "unknown flag" and gets the human-readable output instead.
      let result = await exec(ghPath, ['auth', 'status', '--json', 'hosts'], { env, timeoutMs: 20000, okExitCodes: [1] });
      if (!result.stdout.trim().startsWith('{') && /unknown flag/i.test(result.stderr)) {
        result = await exec(ghPath, ['auth', 'status'], { env, timeoutMs: 20000, okExitCodes: [1] });
      }
      const isJson = result.stdout.trim().startsWith('{');
      const accounts = parseGhAuthStatus(isJson ? result.stdout : `${result.stdout}\n${result.stderr}`);
      const entry = primaryAccount(accounts);
      if (!entry) return { ...none, error: /not logged/i.test(`${result.stdout}${result.stderr}`) ? null : result.stderr.trim() || null };
      const account: GitHubAccount = { login: entry.login, name: null, avatarUrl: null, host: entry.host, scopes: entry.scopes, protocol: entry.protocol };
      try {
        const user = await exec(ghPath, ['api', 'user', '--hostname', entry.host, '--jq', '{login: .login, name: .name, avatar_url: .avatar_url}'], { env, timeoutMs: 20000 });
        const u = JSON.parse(user.stdout) as { login: string; name: string | null; avatar_url: string | null };
        account.name = u.name ?? null;
        account.avatarUrl = u.avatar_url ?? null;
      } catch (err) {
        log.warn(`Could not fetch GitHub profile: ${(err as Error).message}`);
      }
      return { accounts, account, error: null };
    } catch (err) {
      return { ...none, error: (err as Error).message };
    }
  }

  async ghEnv(): Promise<NodeJS.ProcessEnv> {
    const env = { ...(await this.env()) };
    env.GH_PROMPT_DISABLED = '1';
    env.GH_NO_UPDATE_NOTIFIER = '1';
    env.NO_COLOR = '1';
    env.GH_PAGER = 'cat';
    env.PAGER = 'cat';
    delete env.GH_FORCE_TTY;
    delete env.CLICOLOR_FORCE;
    return env;
  }

  /**
   * The account chosen for the repository at `repoPath` (Repository settings → GitHub account) with its
   * token, or null when the repository follows the host's active account. The token is fetched from
   * `gh auth token --user` once and kept in memory only. A chosen account that is no longer signed in
   * is an error: silently using another identity could push as the wrong user.
   */
  async repoAccount(repoPath: string | null | undefined): Promise<{ host: string; token: string } | null> {
    const path = repoPath ?? repoScope.getStore();
    const chosen = path ? (await this.policyRepo(path))?.githubAccount : undefined;
    if (!chosen) return null;
    const key = `${chosen.host}\0${chosen.login}`;
    let token = this.accountTokens.get(key);
    if (!token) {
      token = (async () => {
        await this.ensure('gh');
        const result = await exec(this.ghPath(), ['auth', 'token', '--hostname', chosen.host, '--user', chosen.login], { env: await this.ghEnv(), timeoutMs: 15000 });
        const value = result.stdout.trim();
        if (!value) throw new Error('empty token');
        return value;
      })();
      this.accountTokens.set(key, token);
    }
    try {
      return { host: chosen.host, token: await token };
    } catch {
      this.accountTokens.delete(key);
      throw new GitError({ message: `This repository is set to use the GitHub account ${chosen.login} on ${chosen.host}, which is not signed in. Sign in again from Options → Accounts or choose another account in Repository settings.`, command: '', exitCode: null, stderr: '', stdout: '', code: 'gh-not-authenticated' });
    }
  }

  private async checkCredentialHelper(gitPath: string): Promise<boolean> {
    try {
      const env = await this.env();
      const result = await exec(gitPath, ['config', '--global', '--get-regexp', '^credential\\..*helper$'], { env, timeoutMs: 10000, okExitCodes: [1] });
      const text = result.stdout;
      return /gh auth git-credential/.test(text) || /manager(-core)?\b/.test(text) || /osxkeychain|libsecret|store|cache|wincred/.test(text);
    } catch {
      return false;
    }
  }
}
