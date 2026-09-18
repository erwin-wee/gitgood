import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { GitHubAccount, ToolInfo, ToolsState } from '@shared/types';
import { exec } from './exec';
import { log } from './logger';
import type { Store } from './store';

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

export class ToolLocator {
  private state: ToolsState = {
    git: { installed: false, version: null, path: null, error: null },
    gh: { installed: false, version: null, path: null, error: null },
    claudeCli: { installed: false, version: null, path: null, error: null },
    gitLfs: { installed: false, version: null, path: null, error: null },
    gpg: { installed: false, version: null, path: null, error: null },
    sshKeygen: { installed: false, version: null, path: null, error: null },
    ghAccount: null,
    ghAuthError: null,
    credentialHelperConfigured: false,
  };
  private envCache: NodeJS.ProcessEnv | null = null;
  private refreshing: Promise<ToolsState> | null = null;
  private located: Promise<void> | null = null;

  constructor(private readonly store: Store) {}

  /** process.env augmented with the user's login-shell PATH (mac/Linux GUI launches have a minimal PATH). */
  async env(): Promise<NodeJS.ProcessEnv> {
    if (this.envCache) return this.envCache;
    const env: NodeJS.ProcessEnv = { ...process.env };
    const shellPath = await loginShellPath();
    if (shellPath) {
      const merged = new Set([...(shellPath.split(delimiter)), ...((env.PATH ?? '').split(delimiter))]);
      env.PATH = [...merged].filter(Boolean).join(delimiter);
    }
    this.envCache = env;
    return env;
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
   * Fast local discovery of the git/gh/claude binaries (no network). Runs once;
   * git and gh commands await this so early requests never race the startup scan.
   */
  ensureLocated(): Promise<void> {
    if (this.located) return this.located;
    this.located = (async () => {
      const settings = this.store.getSettings();
      const [git, gh, claudeCli, gpg, sshKeygen] = await Promise.all([
        this.locate('git', settings.gitPath, ['--version'], (o) => /git version (\S+)/.exec(o)?.[1] ?? null),
        this.locate('gh', settings.ghPath, ['--version'], (o) => /gh version (\S+)/.exec(o)?.[1] ?? null),
        this.locate('claude', settings.ai.claudeCliPath, ['--version'], (o) => o.trim().split('\n')[0]?.trim() || null),
        this.locate('gpg', null, ['--version'], (o) => /gpg \(GnuPG\) (\S+)/.exec(o)?.[1] ?? null),
        this.locateSshKeygen(),
      ]);
      const gitLfs = await this.locateLfs(git);
      this.state = { ...this.state, git, gh, claudeCli, gitLfs, gpg, sshKeygen };
    })();
    return this.located;
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

  refresh(): Promise<ToolsState> {
    if (this.refreshing) return this.refreshing;
    this.located = null;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
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

  private async doRefresh(): Promise<ToolsState> {
    await this.ensureLocated();
    const { git, gh, claudeCli } = this.state;
    const next: ToolsState = { ...this.state, git, gh, claudeCli };
    if (gh.installed && gh.path) {
      const auth = await this.readGhAuth(gh.path);
      next.ghAccount = auth.account;
      next.ghAuthError = auth.error;
    } else {
      next.ghAccount = null;
      next.ghAuthError = null;
    }
    next.credentialHelperConfigured = git.installed && git.path ? await this.checkCredentialHelper(git.path) : false;
    this.state = next;
    return next;
  }

  private async readGhAuth(ghPath: string): Promise<{ account: GitHubAccount | null; error: string | null }> {
    const env = await this.ghEnv();
    try {
      const result = await exec(ghPath, ['auth', 'status', '--json', 'hosts'], { env, timeoutMs: 20000, okExitCodes: [1] });
      const text = result.stdout.trim();
      if (!text.startsWith('{')) {
        return { account: null, error: result.stderr.includes('not logged') ? null : result.stderr.trim() || null };
      }
      const parsed = JSON.parse(text) as { hosts: Record<string, { state: string; active: boolean; host: string; login: string; scopes: string; gitProtocol: string }[]> };
      let entry: { state: string; active: boolean; host: string; login: string; scopes: string; gitProtocol: string } | null = null;
      for (const list of Object.values(parsed.hosts ?? {})) {
        const active = list.find((e) => e.active && e.state === 'success') ?? list.find((e) => e.state === 'success');
        if (active) {
          entry = active;
          if (active.host === 'github.com') break;
        }
      }
      if (!entry) return { account: null, error: null };
      const account: GitHubAccount = {
        login: entry.login,
        name: null,
        avatarUrl: null,
        host: entry.host,
        scopes: entry.scopes ? entry.scopes.split(',').map((s) => s.trim()).filter(Boolean) : [],
        protocol: entry.gitProtocol || null,
      };
      try {
        const user = await exec(ghPath, ['api', 'user', '--hostname', entry.host, '--jq', '{login: .login, name: .name, avatar_url: .avatar_url}'], { env, timeoutMs: 20000 });
        const u = JSON.parse(user.stdout) as { login: string; name: string | null; avatar_url: string | null };
        account.name = u.name ?? null;
        account.avatarUrl = u.avatar_url ?? null;
      } catch (err) {
        log.warn(`Could not fetch GitHub profile: ${(err as Error).message}`);
      }
      return { account, error: null };
    } catch (err) {
      return { account: null, error: (err as Error).message };
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
