import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findExecutable } from '../../src/main/tools';
import { createFakeTools } from './fake-tools';

let cachedGitPath: string | null | undefined;

/** Locates the real `git` on PATH once; cached for the whole test run. */
export async function findGit(): Promise<string | null> {
  if (cachedGitPath !== undefined) return cachedGitPath;
  cachedGitPath = await findExecutable('git', [], process.env.PATH);
  return cachedGitPath;
}

/** Synchronous check for `describe.skipIf` at collection time (no `await` available there). */
export function hasGitSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Synchronous check for `describe.skipIf`: true only when `git lfs` (the extension) is actually installed. Most LFS behaviour (attribute detection, pointer parsing) needs only plain git and is not gated on this. */
export function hasGitLfsSync(): boolean {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment that keeps every git/gh invocation inside a temp directory:
 * no real HOME, no real global gitconfig, no system config, isolated XDG and
 * gh config directories. Never touches the developer's real configuration.
 */
export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig-empty'),
    GIT_CONFIG_SYSTEM: join(root, 'gitconfig-empty'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: join(root, 'gh-config'),
    GITGOOD_USER_DATA: join(root, 'userdata'),
  };
}

export interface RepoCommitOptions {
  message: string;
  /** path -> content; parent directories are created as needed. */
  files?: Record<string, string>;
  /** Paths to `git rm` before committing. */
  remove?: string[];
  date?: string;
  allowEmpty?: boolean;
}

export interface CreateRepoOptions {
  /** Commits to create on `main` right after init. */
  commits?: RepoCommitOptions[];
  /** Additional local branches to create (name -> start point, default HEAD) once commits exist. */
  branches?: Record<string, string | undefined>;
  /** Branch to leave checked out at the end; defaults to whatever HEAD already is. */
  checkout?: string;
  /** When true, creates a bare `origin` remote and pushes every local branch to it. */
  remote?: boolean;
}

export interface TestRepo {
  /** Root temp directory holding the repo, isolated HOME, and (optionally) the bare remote. */
  root: string;
  /** The working repository. */
  path: string;
  /** Path to the bare `origin` remote, or null when `remote` was not requested. */
  remotePath: string | null;
  /** Env every git/gh invocation in this fixture should use. */
  env: NodeJS.ProcessEnv;
  /** Absolute path to the real `git` binary used to build the fixture. */
  gitBin: string;
  /** Runs `git` directly against this repo (for fixture setup/assertions, not the code under test). */
  git(args: string[], cwd?: string): string;
  /** Writes staged/committed files and commits them with deterministic identity/date. */
  commit(opts: RepoCommitOptions): string;
  /** Writes a file (creating parent directories) without staging or committing it. */
  write(path: string, content: string): Promise<void>;
  /** A fake `ToolLocator` wired to this repo's isolated env and real git binary. */
  tools(overrides?: Parameters<typeof createFakeTools>[0]): ReturnType<typeof createFakeTools>;
  dispose(): Promise<void>;
}

let seq = 0;

export async function createRepo(options: CreateRepoOptions = {}): Promise<TestRepo> {
  const gitBin = await findGit();
  if (!gitBin) throw new Error('git was not found on PATH; fixture tests require a real git installation.');
  seq += 1;
  const root = await mkdtemp(join(tmpdir(), `gg-repo-${seq}-`));
  const repoPath = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(repoPath, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(root, 'gitconfig-empty'), '', 'utf8');

  const env = isolatedEnv(root);
  let remotePath: string | null = null;

  const run = (args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): string =>
    execFileSync(gitBin, args, { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');

  run(['init', '-q', '-b', 'main', repoPath], root);
  run(['config', 'user.name', 'Test User'], repoPath);
  run(['config', 'user.email', 'test@example.com'], repoPath);
  run(['config', 'core.autocrlf', 'false'], repoPath);
  run(['config', 'commit.gpgsign', 'false'], repoPath);
  run(['config', 'tag.gpgsign', 'false'], repoPath);

  let commitSeq = 0;
  const commit = (opts: RepoCommitOptions): string => {
    for (const rel of opts.remove ?? []) run(['rm', '-q', '--', rel], repoPath);
    for (const [rel, content] of Object.entries(opts.files ?? {})) {
      const full = join(repoPath, ...rel.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    if ((opts.files && Object.keys(opts.files).length) || (opts.remove && opts.remove.length)) run(['add', '-A'], repoPath);
    commitSeq += 1;
    const date = opts.date ?? `2024-01-01T00:${String(commitSeq).padStart(2, '0')}:00Z`;
    const args = ['commit', '-q', '-m', opts.message];
    if (opts.allowEmpty) args.push('--allow-empty');
    run(args, repoPath, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return run(['rev-parse', 'HEAD'], repoPath).trim();
  };

  for (const c of options.commits ?? []) commit(c);

  for (const [name, start] of Object.entries(options.branches ?? {})) {
    run(['branch', name, ...(start ? [start] : [])], repoPath);
  }

  if (options.checkout) run(['checkout', options.checkout], repoPath);

  if (options.remote) {
    remotePath = join(root, 'origin.git');
    run(['init', '-q', '--bare', '-b', 'main', remotePath], root);
    run(['remote', 'add', 'origin', remotePath], repoPath);
    const branches = run(['branch', '--format=%(refname:short)'], repoPath)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (branches.length) run(['push', '-q', 'origin', ...branches], repoPath);
    const current = run(['branch', '--show-current'], repoPath).trim();
    if (current) run(['push', '-q', '-u', 'origin', current], repoPath);
  }

  return {
    root,
    path: repoPath,
    remotePath,
    env,
    gitBin,
    git: (args: string[], cwd = repoPath) => run(args, cwd),
    commit,
    async write(rel: string, content: string): Promise<void> {
      const full = join(repoPath, ...rel.split('/'));
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    },
    tools(overrides = {}) {
      return createFakeTools({ gitPath: gitBin, env, ...overrides });
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
