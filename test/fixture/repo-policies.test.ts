import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { clientContext } from '../../src/main/core/client-context';
import { createHandlers, type CoreHandlers, type HandlerDeps } from '../../src/main/core/handlers';
import { GitClient } from '../../src/main/git/git';
import { RepositoryManager } from '../../src/main/repo/manager';
import { Store } from '../../src/main/store';
import { ToolLocator } from '../../src/main/tools';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

const posix = process.platform !== 'win32';
const ACCOUNT = { host: 'github.com', login: 'work-bot' };

describe.skipIf(!hasGitSync() || !posix)('linked worktrees follow their main repository policy', () => {
  let repo: TestRepo;
  let store: Store;
  let manager: RepositoryManager;
  let tools: ToolLocator;
  let networkLog: string;

  async function stub(name: string, body: string): Promise<string> {
    const path = join(repo.root, 'stubs', name);
    await mkdir(join(repo.root, 'stubs'), { recursive: true });
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  beforeEach(async () => {
    vi.stubEnv('SHELL', '/bin/sh');
    vi.stubEnv('GH_TOKEN', '');
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    networkLog = join(repo.root, 'network.log');
    // git: network commands only record the token they were given; everything else is the real git.
    const git = await stub('git', `case " $* " in *" fetch "*|*" push "*) echo "$GH_TOKEN" >> "${networkLog}"; exit 0;; esac\nexec "${repo.gitBin}" "$@"`);
    const gh = await stub('gh', `case "$*" in *--version*) echo "gh version 2.101.0";; "auth token --hostname github.com --user work-bot") echo "tok_work";; esac`);
    store = new Store(join(repo.root, 'userdata'));
    store.load();
    const settings = { ...DEFAULT_SETTINGS, gitPath: git, ghPath: gh };
    tools = new ToolLocator({ getSettings: () => settings, getRepositories: () => store.getRepositories() } as unknown as Store);
    manager = new RepositoryManager(store, new GitClient(tools), () => undefined);
    tools.policyRepo = (p) => manager.policyRepo(p);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    manager.dispose();
    await repo.dispose();
  });

  async function mainWithPolicy(): Promise<{ registered: string; derived: string }> {
    const main = await manager.add(repo.path);
    const registered = join(repo.root, 'wt-registered');
    const derived = join(repo.root, 'wt-derived');
    repo.git(['worktree', 'add', '-b', 'one', registered]);
    repo.git(['worktree', 'add', '-b', 'two', derived]);
    await manager.add(registered);
    await manager.setPrefs(main.id, { githubAccount: ACCOUNT });
    await manager.setAiDisabled(main.id, true);
    return { registered, derived };
  }

  it('uses the main repository account for network git and gh in registered and unregistered worktrees', async () => {
    const { registered, derived } = await mainWithPolicy();
    expect(manager.getByPath(derived)).toBeNull(); // really only known to git
    for (const dir of [repo.path, registered, derived]) {
      expect(await tools.repoAccount(dir)).toEqual({ host: 'github.com', token: 'tok_work' });
      await new GitClient(tools).run(dir, ['fetch']);
    }
    expect((await readFile(networkLog, 'utf8')).trim().split('\n')).toEqual(['tok_work', 'tok_work', 'tok_work']);
    expect(JSON.stringify(store.getRepositories())).not.toContain('tok_work');
  });

  it('leaves worktrees of a main without a chosen account on the active identity', async () => {
    await manager.add(repo.path);
    const dir = join(repo.root, 'wt');
    repo.git(['worktree', 'add', '-b', 'one', dir]);
    expect(await tools.repoAccount(dir)).toBeNull();
  });

  it('shows the inherited AI opt-out and account on registered and derived worktree entries', async () => {
    const { registered, derived } = await mainWithPolicy();
    const list = await manager.list();
    for (const dir of [registered, derived]) expect(list.find((r) => r.path === dir)).toMatchObject({ aiDisabled: true, githubAccount: ACCOUNT });
    expect(store.getRepositories().find((r) => r.path === registered)?.aiDisabled).toBeUndefined(); // not persisted on the worktree
  });

  it('refuses AI handlers in worktrees of an AI-disabled main, and honours a worktree-only config opt-out', async () => {
    const triage = { get: vi.fn(async () => 'ran') };
    const { handlers } = createHandlers({ store, repos: manager, triage, nlPalette: { setDispatcher: () => undefined } } as unknown as HandlerDeps);
    const { registered, derived } = await mainWithPolicy();
    for (const dir of [repo.path, registered, derived]) await expect(handlers['ai.triage.get'](dir)).rejects.toThrow(/turned off for this repository on this machine/);
    expect(triage.get).not.toHaveBeenCalled();

    await manager.setAiDisabled(manager.getByPath(repo.path)!.id, false);
    await expect(handlers['ai.triage.get'](derived)).resolves.toBe('ran');
    await mkdir(join(registered, '.gitgood'), { recursive: true });
    await writeFile(join(registered, '.gitgood', 'config.json'), '{"ai": false}');
    await expect(handlers['ai.triage.get'](registered)).rejects.toThrow(/config\.json/);
    await expect(handlers['ai.triage.get'](derived)).resolves.toBe('ran');
  });
});

describe.skipIf(!hasGitSync())('update install gate across open repositories', () => {
  let a: TestRepo;
  let b: TestRepo;
  let manager: RepositoryManager;
  let handlers: CoreHandlers['handlers'];
  let quitAndInstall: Mock;
  let aiActive: boolean;

  beforeEach(async () => {
    a = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    b = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    // Repository A is mid-merge with a conflict.
    a.git(['checkout', '-q', '-b', 'topic']);
    a.commit({ message: 'topic', files: { 'a.txt': 'topic\n' } });
    a.git(['checkout', '-q', 'main']);
    a.commit({ message: 'main', files: { 'a.txt': 'main\n' } });
    expect(() => a.git(['merge', 'topic'])).toThrow();

    const store = new Store(join(a.root, 'userdata'));
    store.load();
    const git = new GitClient(a.tools());
    manager = new RepositoryManager(store, git, () => undefined);
    quitAndInstall = vi.fn(async () => undefined);
    aiActive = false;
    const idle = { isActive: () => aiActive };
    const deps = { store, git, tools: a.tools(), repos: manager, resolver: idle, review: idle, triage: idle, prDraft: idle, releaseNotes: idle, explain: idle, errorExplain: idle, splitter: idle, rebasePlan: idle, nlPalette: { ...idle, setDispatcher: () => undefined }, updater: { quitAndInstall }, emit: () => undefined };
    handlers = createHandlers(deps as unknown as HandlerDeps).handlers;
  });

  afterEach(async () => {
    manager.dispose();
    await Promise.all([a.dispose(), b.dispose()]);
  });

  const as = <T>(client: string, fn: () => Promise<T>): Promise<T> => Promise.resolve(clientContext.run(client, fn));

  it('refuses while any window has a repository mid-operation, even when another window opened last', async () => {
    await as('window-1', () => handlers['repo.open'](a.path));
    await as('window-2', () => handlers['repo.open'](b.path)); // B is now the last-opened repository
    await expect(as('window-1', () => handlers['app.update.install']())).rejects.toThrow(/merge is in progress/);
    await expect(as('window-2', () => handlers['app.update.install']())).rejects.toThrow(/merge is in progress/);
    expect(quitAndInstall).not.toHaveBeenCalled();

    a.git(['merge', '--abort']);
    await as('window-2', () => handlers['app.update.install']());
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('is not blocked by a conflicted repository nobody has open', async () => {
    await as('window-1', () => handlers['repo.open'](a.path));
    await as('window-1', () => handlers['repo.open'](b.path)); // the window switched away from A
    await as('window-1', () => handlers['app.update.install']());
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('refuses when an open repository cannot be checked, and while AI is active', async () => {
    await as('window-1', () => handlers['repo.open'](b.path));
    await rm(join(b.path, '.git'), { recursive: true, force: true });
    await expect(as('window-1', () => handlers['app.update.install']())).rejects.toThrow(/could not check/);

    await as('window-1', () => handlers['repo.close'](b.path));
    aiActive = true;
    await expect(as('window-1', () => handlers['app.update.install']())).rejects.toThrow(/AI/);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });
});
