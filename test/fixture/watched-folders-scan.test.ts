import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { RepositoryManager, repositoryId, resolvedKey } from '../../src/main/repo/manager';
import { addWatchedFolder, clampDepth, sanitizeWatchedFolders, watchedFoldersDiffer, WatchedFolderScanner } from '../../src/main/repo/watched-folders';
import { Store } from '../../src/main/store';
import type { EventPayloads } from '../../src/shared/ipc';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

const canTestUnreadable = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

interface Harness {
  repo: TestRepo;
  store: Store;
  manager: RepositoryManager;
  scanner: WatchedFolderScanner;
  events: { event: string; payload: unknown }[];
  /** Creates a git repository at `root/<segments>` and returns its path. */
  makeRepo: (...segments: string[]) => string;
  watch: (path: string, depth?: number) => void;
  /** Absolute path under the harness root (no repository created). */
  at: (...segments: string[]) => string;
}

async function harness(): Promise<Harness> {
  const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
  const store = new Store(join(repo.root, 'userdata'));
  store.load();
  const git = new GitClient(repo.tools());
  const events: { event: string; payload: unknown }[] = [];
  const send = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]): void => {
    events.push({ event, payload });
  };
  const manager = new RepositoryManager(store, git, send);
  const scanner = new WatchedFolderScanner(store, manager, send);

  const makeRepo = (...segments: string[]): string => {
    const dir = join(repo.root, ...segments);
    mkdirSync(dir, { recursive: true });
    const run = (args: string[]): void => {
      execFileSync(repo.gitBin, args, { cwd: dir, env: repo.env, stdio: 'ignore' });
    };
    execFileSync(repo.gitBin, ['init', '-q', '-b', 'main', dir], { env: repo.env, stdio: 'ignore' });
    // The isolated env has no global identity, so anything that commits here
    // (e.g. creating a worktree) needs one configured locally.
    run(['config', 'user.name', 'Test User']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'commit.gpgsign', 'false']);
    return dir;
  };

  const watch = (path: string, depth = 3): void => {
    store.updateSettings({ watchedFolders: [...store.getSettings().watchedFolders, { path, depth }] });
  };

  const at = (...segments: string[]): string => join(repo.root, ...segments);

  return { repo, store, manager, scanner, events, makeRepo, watch, at };
}

describe.skipIf(!hasGitSync())('watched folder scanning', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.repo.dispose();
    h = undefined;
  });

  // -------------------------------------------------------------------------
  // addMany
  // -------------------------------------------------------------------------

  it('adds several repositories with a single repos.changed and marks them watched', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    const b = h.makeRepo('projects', 'org', 'b');

    h.events.length = 0;
    const { added, skipped } = await h.manager.addMany([a, b]);

    expect(added.map((r) => r.path).sort()).toEqual([a, b].sort());
    expect(skipped).toBe(0);
    expect(added.every((r) => r.origin === 'watched')).toBe(true);
    expect(h.events.filter((e) => e.event === 'repos.changed')).toHaveLength(1);
    expect(existsSync(projects)).toBe(true);
  });

  it('does not duplicate a repository already added by hand, and leaves its origin and alias alone', async () => {
    h = await harness();
    const a = h.makeRepo('projects', 'a');
    const manual = await h.manager.add(a);
    await h.manager.setAlias(manual.id, 'My repo');

    const { added, skipped } = await h.manager.addMany([a]);

    expect(added).toEqual([]);
    expect(skipped).toBe(1);
    const stored = h.store.getRepositories();
    expect(stored).toHaveLength(1);
    expect(stored[0].origin).toBeUndefined();
    expect(stored[0].alias).toBe('My repo');
  });

  it('skips a path the user has excluded', async () => {
    h = await harness();
    const a = h.makeRepo('projects', 'a');
    h.store.addExcludedRepositoryPath(a);

    const { added, skipped } = await h.manager.addMany([a]);
    expect(added).toEqual([]);
    expect(skipped).toBe(1);
    expect(h.store.getRepositories()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // resolved-path dedupe (3.1a)
  // -------------------------------------------------------------------------

  it('resolves a symlinked path to the same repository', async () => {
    h = await harness();
    const real = h.makeRepo('projects', 'gitgood');
    const link = join(h.repo.root, 'code-gitgood');
    symlinkSync(real, link, 'dir');
    expect(await resolvedKey(link)).toBe(await resolvedKey(real));
  });

  it('normalizes an add through a symlink to the real path, so there is one entry either way', async () => {
    h = await harness();
    const real = h.makeRepo('projects', 'gitgood');
    const link = join(h.repo.root, 'code-gitgood');
    symlinkSync(real, link, 'dir');

    // git rev-parse --show-toplevel resolves the link itself, so the entry is
    // stored under the real path; the scan then matches it on id alone.
    const viaLink = await h.manager.add(link);
    expect(viaLink.path).toBe(real);

    const { added, skipped } = await h.manager.addMany([real]);
    expect(added).toEqual([]);
    expect(skipped).toBe(1);
    expect(h.store.getRepositories()).toHaveLength(1);
  });

  it('does not add a second entry for a stored path that only resolves to a known repository', async () => {
    h = await harness();
    const real = h.makeRepo('projects', 'gitgood');
    const link = join(h.repo.root, 'code-gitgood');
    symlinkSync(real, link, 'dir');

    // A settings import stores the paths from the file verbatim, so an entry
    // can hold a symlink path that git would never have produced. This is the
    // case resolvedKey exists for: ids differ, the repository is the same.
    h.store.saveRepositories([
      { id: repositoryId(link), path: link, name: 'gitgood', alias: null, missing: false, github: null, lastOpened: 0, indicator: null, worktreeOf: null, parentRepoId: null },
    ]);
    expect(repositoryId(link)).not.toBe(repositoryId(real));

    const { added, skipped } = await h.manager.addMany([real]);

    expect(added).toEqual([]);
    expect(skipped).toBe(1);
    expect(h.store.getRepositories()).toHaveLength(1);
  });

  it('keeps a linked worktree as an entry separate from its main repository', async () => {
    h = await harness();
    const main = await h.manager.add(h.repo.path);
    const wt = join(h.repo.root, 'wt-feature');
    h.repo.git(['worktree', 'add', '-q', '-b', 'feature', wt]);

    const { added } = await h.manager.addMany([wt]);

    expect(added).toHaveLength(1);
    expect(added[0].path).toBe(wt);
    expect(added[0].worktreeOf).toBe(main.id);
    expect(added[0].id).not.toBe(main.id);
    expect(h.store.getRepositories()).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scanner
  // -------------------------------------------------------------------------

  it('finds repositories under a watched folder and reports the summary', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    const b = h.makeRepo('projects', 'org', 'b');
    h.makeRepo('projects', 'node_modules', 'decoy');
    h.watch(projects, 3);

    const result = await h.scanner.scan();

    expect(result.added).toBe(2);
    expect(result.cancelled).toBe(false);
    expect(result.folders).toEqual([{ path: projects, problem: null }]);
    expect(h.store.getRepositories().map((r) => r.path).sort()).toEqual([a, b].sort());
  });

  it('reports alreadyRunning for a second scan and leaves the first alone', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    h.makeRepo('projects', 'a');
    h.watch(projects, 3);

    const first = h.scanner.scan();
    const second = await h.scanner.scan();
    expect(second.alreadyRunning).toBe(true);
    expect(second.added).toBe(0);

    const result = await first;
    expect(result.added).toBe(1);
    expect(result.alreadyRunning).toBeUndefined();
  });

  it('does nothing when no folder is watched', async () => {
    h = await harness();
    const result = await h.scanner.scan();
    expect(result).toMatchObject({ added: 0, skipped: 0, cancelled: false, folders: [] });
  });

  it('flags a folder that is missing or not a directory without dropping it', async () => {
    h = await harness();
    const missing = join(h.repo.root, 'not-there');
    const file = join(h.repo.root, 'a-file');
    await h.repo.write('../a-file', 'x');
    h.watch(missing);
    h.watch(file);

    const result = await h.scanner.scan();

    expect(result.folders).toEqual([
      { path: missing, problem: 'missing' },
      { path: file, problem: 'not-a-directory' },
    ]);
    expect(h.store.getSettings().watchedFolders).toHaveLength(2);
  });

  it('emits progress events while scanning', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    h.makeRepo('projects', 'a');
    h.watch(projects, 3);

    await h.scanner.scan();
    expect(h.events.some((e) => e.event === 'repos.scanProgress')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Drop pass (3.3)
  // -------------------------------------------------------------------------

  it('drops a discovered repository whose folder was deleted, without excluding it', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    h.makeRepo('projects', 'b');
    h.watch(projects, 3);
    await h.scanner.scan();
    expect(h.store.getRepositories()).toHaveLength(2);

    await rm(a, { recursive: true, force: true });
    const result = await h.scanner.scan();

    expect(result.dropped).toBe(1);
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([join(projects, 'b')]);
    expect(h.store.getExcludedRepositoryPaths()).toEqual([]);
  });

  it('keeps a manually added repository whose folder was deleted', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    await h.manager.add(a);
    h.watch(projects, 3);

    await rm(a, { recursive: true, force: true });
    const result = await h.scanner.scan();

    expect(result.dropped).toBe(0);
    expect(h.store.getRepositories()).toHaveLength(1);
    expect((await h.manager.list())[0].missing).toBe(true);
  });

  it('does not drop anything from a cancelled scan', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    h.watch(projects, 3);
    await h.scanner.scan();

    await rm(a, { recursive: true, force: true });
    // Cancel as soon as the walk starts, before the drop pass could run.
    const promise = h.scanner.scan();
    h.scanner.cancel();
    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(result.dropped).toBe(0);
    expect(h.store.getRepositories()).toHaveLength(1);
  });

  it.runIf(canTestUnreadable)('does not drop a repository beneath an unreadable directory', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const locked = join(projects, 'locked');
    mkdirSync(locked, { recursive: true });
    const inside = h.makeRepo('projects', 'locked', 'repo');
    h.watch(projects, 4);
    await h.scanner.scan();
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([inside]);

    chmodSync(locked, 0o000);
    try {
      const result = await h.scanner.scan();
      expect(result.unreadable).toBeGreaterThan(0);
      expect(result.dropped).toBe(0);
      expect(h.store.getRepositories()).toHaveLength(1);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  // -------------------------------------------------------------------------
  // Exclusions on removal (3.4)
  // -------------------------------------------------------------------------

  it('excludes a discovered repository on removal so a rescan does not add it back', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    h.watch(projects, 3);
    await h.scanner.scan();

    const info = h.manager.getByPath(a)!;
    await h.manager.remove(info.id);
    expect(h.store.isRepositoryExcluded(a)).toBe(true);

    const result = await h.scanner.scan();
    expect(result.added).toBe(0);
    expect(h.store.getRepositories()).toHaveLength(0);
  });

  it('excludes a hand-added repository inside a watched folder too', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    h.watch(projects, 3);
    const manual = await h.manager.add(a);
    expect(manual.origin).toBeUndefined();

    await h.manager.remove(manual.id);
    expect(h.store.isRepositoryExcluded(a)).toBe(true);

    const result = await h.scanner.scan();
    expect(result.added).toBe(0);
    expect(h.store.getRepositories()).toHaveLength(0);
  });

  it('records no exclusion for a repository outside every watched folder', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    h.watch(projects, 3);
    const outside = h.makeRepo('elsewhere', 'c');
    const info = await h.manager.add(outside);

    await h.manager.remove(info.id);
    expect(h.store.getExcludedRepositoryPaths()).toEqual([]);
  });

  it('adds an un-excluded repository again on the next scan', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    h.watch(projects, 3);
    await h.scanner.scan();
    await h.manager.remove(repositoryId(a));
    expect((await h.scanner.scan()).added).toBe(0);

    h.store.removeExcludedRepositoryPath(a);
    const result = await h.scanner.scan();

    expect(result.added).toBe(1);
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([a]);
  });

  // -------------------------------------------------------------------------
  // Watched folders reached through a symlink (regression)
  // -------------------------------------------------------------------------

  it('discovers repositories when the watched folder itself is a symlink', async () => {
    h = await harness();
    const real = h.makeRepo('real', 'projects', 'a');
    symlinkSync(h.at('real', 'projects'), h.at('link-projects'), 'dir');
    h.watch(h.at('link-projects'), 3);

    const result = await h.scanner.scan();

    expect(result.added).toBe(1);
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([real]);
  });

  it('discovers repositories when only an ancestor of the watched folder is a symlink', async () => {
    h = await harness();
    const real = h.makeRepo('real', 'projects', 'a');
    symlinkSync(h.at('real'), h.at('link'), 'dir');
    h.watch(join(h.at('link'), 'projects'), 3);

    const result = await h.scanner.scan();

    expect(result.added).toBe(1);
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([real]);
  });

  it('treats a repository under a symlinked watched folder as inside it, so removal excludes it', async () => {
    h = await harness();
    const real = h.makeRepo('real', 'projects', 'a');
    symlinkSync(h.at('real', 'projects'), h.at('link-projects'), 'dir');
    h.watch(h.at('link-projects'), 3);
    await h.scanner.scan();

    expect(await h.manager.isInWatchedFolder(real)).toBe(true);
    await h.manager.remove(repositoryId(real));
    expect(h.store.isRepositoryExcluded(real)).toBe(true);
    expect((await h.scanner.scan()).added).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Worktrees discovered before their main repository (regression)
  // -------------------------------------------------------------------------

  it('marks a main repository pulled in by a worktree as discovered, counts it, and does not bump it to the top of recents', async () => {
    h = await harness();
    // 'awt' sorts before 'zmain', so the walk reaches the worktree first.
    const projects = h.at('projects');
    const main = h.makeRepo('projects', 'zmain');
    h.repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    const wt = join(projects, 'awt');
    h.repo.git(['worktree', 'add', '-q', '-b', 'feature', wt], main);
    h.watch(projects, 3);

    const result = await h.scanner.scan();

    const stored = h.store.getRepositories();
    expect(stored).toHaveLength(2);
    expect(result.added).toBe(2);
    const mainEntry = stored.find((r) => r.path === main)!;
    expect(mainEntry.origin).toBe('watched');
    expect(mainEntry.lastOpened).toBe(0);
    expect(stored.find((r) => r.path === wt)!.worktreeOf).toBe(mainEntry.id);
  });

  it('does not drop a discovered worktree that lives outside the scanned folder', async () => {
    h = await harness();
    const projects = h.at('projects');
    const main = h.makeRepo('projects', 'main');
    h.repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    const wt = h.at('elsewhere', 'wt');
    h.repo.git(['worktree', 'add', '-q', '-b', 'feat', wt], main);
    h.watch(projects, 3);
    await h.manager.addMany([main, wt]);
    expect(h.store.getRepositories()).toHaveLength(2);

    // Both gone, but only the main is inside the folder being scanned: the
    // worktree is another scan's to judge, so this one leaves it alone.
    await rm(main, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
    const result = await h.scanner.scan();

    expect(result.dropped).toBe(1);
    const stored = h.store.getRepositories();
    expect(stored.map((r) => r.path)).toEqual([wt]);
    expect(stored[0].worktreeOf).toBeNull();
  });

  it('does not drop a manually added worktree that is still on disk when its main vanishes', async () => {
    h = await harness();
    const projects = h.at('projects');
    const main = h.makeRepo('projects', 'main');
    h.repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    const wt = h.at('wt-feature');
    h.repo.git(['worktree', 'add', '-q', '-b', 'feature', wt], main);
    h.watch(projects, 3);
    await h.scanner.scan();
    await h.manager.add(wt);
    expect(h.store.getRepositories()).toHaveLength(2);

    await rm(main, { recursive: true, force: true });
    const result = await h.scanner.scan();

    expect(result.dropped).toBe(1);
    const stored = h.store.getRepositories();
    expect(stored.map((r) => r.path)).toEqual([wt]);
    // Re-parented rather than left pointing at a repository that is gone.
    expect(stored[0].worktreeOf).toBeNull();
    expect(existsSync(wt)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Implicitly registered main repositories (second-review regressions)
  // -------------------------------------------------------------------------

  it('does not resurrect an excluded repository through one of its worktrees', async () => {
    h = await harness();
    const projects = h.at('projects');
    const main = h.makeRepo('projects', 'main');
    h.repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    h.watch(projects, 3);
    await h.scanner.scan();
    await h.manager.remove(repositoryId(main));
    expect(h.store.isRepositoryExcluded(main)).toBe(true);

    // A worktree of the excluded repository appears later (created in a terminal).
    h.repo.git(['worktree', 'add', '-q', '-b', 'feat', join(projects, 'wt')], main);
    const result = await h.scanner.scan();

    expect(h.store.getRepositories().some((r) => r.path === main)).toBe(false);
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([join(projects, 'wt')]);
    // The worktree is kept, just not nested under a repository that is excluded.
    expect(h.store.getRepositories()[0].worktreeOf).toBeNull();
    expect(result.added).toBe(1);
  });

  it('counts a main and its worktree once each, never as both added and already known', async () => {
    h = await harness();
    const projects = h.at('projects');
    const main = h.makeRepo('projects', 'zmain');
    h.repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    h.repo.git(['worktree', 'add', '-q', '-b', 'feat', join(projects, 'awt')], main);
    h.watch(projects, 3);

    const result = await h.scanner.scan();

    expect(h.store.getRepositories()).toHaveLength(2);
    expect({ added: result.added, skipped: result.skipped, failed: result.failed }).toEqual({ added: 2, skipped: 0, failed: 0 });
  });

  it('does not report a repository another caller added while the scan ran', async () => {
    h = await harness();
    const projects = h.at('projects');
    h.makeRepo('projects', 'a');
    const unrelated = h.makeRepo('elsewhere', 'b');

    const scan = h.manager.addMany([join(projects, 'a')]);
    const manual = h.manager.add(unrelated);
    const [result] = await Promise.all([scan, manual]);

    expect(result.added.map((r) => r.path)).toEqual([join(projects, 'a')]);
    expect(h.store.getRepositories()).toHaveLength(2);
  });

  it('leaves a main outside every watched folder marked manual', async () => {
    h = await harness();
    const projects = h.at('projects');
    const main = h.makeRepo('outside', 'main');
    h.repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    h.repo.git(['worktree', 'add', '-q', '-b', 'feat', join(projects, 'wt')], main);
    h.watch(projects, 3);

    await h.scanner.scan();

    const stored = h.store.getRepositories();
    const mainEntry = stored.find((r) => r.path === main)!;
    // Registered on the scan's behalf, but not inside a watched folder, so the
    // scanner does not own it and must not be able to drop it later.
    expect(mainEntry.origin).toBeUndefined();
    expect(mainEntry.lastOpened).toBe(0);
    expect(stored.find((r) => r.path === join(projects, 'wt'))!.origin).toBe('watched');
  });

  it('excludes by physical path, so a symlinked entry is not re-added', async () => {
    h = await harness();
    const real = h.makeRepo('real', 'projects', 'a');
    symlinkSync(h.at('real', 'projects'), h.at('link-projects'), 'dir');
    h.watch(h.at('link-projects'), 3);
    // An entry stored under the symlink path, as a settings import leaves it.
    h.store.saveRepositories([
      { id: repositoryId(h.at('link-projects', 'a')), path: h.at('link-projects', 'a'), name: 'a', alias: null, missing: false, github: null, lastOpened: 0, indicator: null, worktreeOf: null, parentRepoId: null, origin: 'watched' },
    ]);

    await h.manager.remove(repositoryId(h.at('link-projects', 'a')));
    const result = await h.scanner.scan();

    expect(result.added).toBe(0);
    expect(h.store.getRepositories()).toEqual([]);
    expect(h.store.isRepositoryExcluded(real)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cancellation mid-walk
  // -------------------------------------------------------------------------

  it('does not drop anything when the walk is cancelled after it started', async () => {
    h = await harness();
    const projects = h.at('projects');
    const gone = h.makeRepo('projects', 'a');
    for (const name of ['b', 'c', 'd', 'e', 'f']) h.makeRepo('projects', name);
    h.watch(projects, 3);
    await h.scanner.scan();
    await rm(gone, { recursive: true, force: true });

    // Cancel from a progress event, i.e. once the walk is genuinely under way.
    const stop = (): void => h.scanner.cancel();
    const originalSend = h.events.push.bind(h.events);
    h.events.push = ((entry: { event: string; payload: unknown }) => {
      if (entry.event === 'repos.scanProgress') stop();
      return originalSend(entry);
    }) as typeof h.events.push;

    const result = await h.scanner.scan();

    expect(result.cancelled).toBe(true);
    expect(result.dropped).toBe(0);
    expect(h.store.getRepositories().some((r) => r.path === gone)).toBe(true);
  });

  it('clamps a depth that was hand-edited out of range in settings.json', async () => {
    h = await harness();
    const projects = h.at('projects');
    const a = h.makeRepo('projects', 'a');
    h.store.updateSettings({ watchedFolders: [{ path: projects, depth: 0 }] });

    const result = await h.scanner.scan();

    expect(result.added).toBe(1);
    expect(h.store.getRepositories().map((r) => r.path)).toEqual([a]);
  });

  // -------------------------------------------------------------------------
  // Settings-driven rescans (4.2)
  // -------------------------------------------------------------------------

  it('rescans when a watched folder is added but not when an unrelated setting changes', async () => {
    h = await harness();
    const projects = join(h.repo.root, 'projects');
    const a = h.makeRepo('projects', 'a');
    const stop = h.scanner.watchSettings();
    try {
      h.store.updateSettings({ theme: 'dark' });
      expect(h.scanner.isScanning()).toBe(false);
      expect(h.store.getRepositories()).toHaveLength(0);

      h.watch(projects, 3);
      // The listener starts the scan synchronously; wait for it to finish.
      await new Promise((r) => setTimeout(r, 300));
      expect(h.store.getRepositories().map((r) => r.path)).toEqual([a]);
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Registration validation (3.5) - pure, no git needed
// ---------------------------------------------------------------------------

describe('watched folder registration', () => {
  const root = process.platform === 'win32' ? 'C:\\Users\\me\\Projects' : '/home/me/Projects';
  const sub = join(root, 'work');

  it('adds a folder with the default depth', () => {
    const result = addWatchedFolder([], root);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.folders).toEqual([{ path: root, depth: 3 }]);
  });

  it('rejects a duplicate', () => {
    const result = addWatchedFolder([{ path: root, depth: 3 }], root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(root);
  });

  it.runIf(process.platform === 'win32')('rejects a duplicate that differs only in case', () => {
    const result = addWatchedFolder([{ path: root, depth: 3 }], root.toLowerCase());
    expect(result.ok).toBe(false);
  });

  it('rejects a folder nested inside one already watched, naming the covering folder', () => {
    const result = addWatchedFolder([{ path: root, depth: 3 }], sub);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(root);
  });

  it('rejects a folder that would contain one already watched', () => {
    const result = addWatchedFolder([{ path: sub, depth: 3 }], root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(sub);
  });

  it('accepts a sibling that merely shares a prefix', () => {
    const sibling = `${root}-archive`;
    expect(addWatchedFolder([{ path: root, depth: 3 }], sibling).ok).toBe(true);
  });

  it('clamps depth into 1-10', () => {
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(-5)).toBe(1);
    expect(clampDepth(11)).toBe(10);
    expect(clampDepth(4)).toBe(4);
    expect(clampDepth(2.4)).toBe(2);
    expect(clampDepth(Number.NaN)).toBe(3);
  });

  it('sanitizes a list arriving from a settings patch', () => {
    const folders = sanitizeWatchedFolders([
      { path: root, depth: 99 },
      { path: root, depth: 3 },
      { path: sub, depth: 2 },
      { path: '   ', depth: 3 },
    ]);
    expect(folders).toEqual([{ path: root, depth: 10 }]);
  });

  it('spots the changes that call for a rescan', () => {
    const a = [{ path: root, depth: 3 }];
    expect(watchedFoldersDiffer(a, [{ path: root, depth: 3 }])).toBe(false);
    expect(watchedFoldersDiffer(a, [{ path: root, depth: 4 }])).toBe(true);
    expect(watchedFoldersDiffer(a, [])).toBe(true);
    expect(watchedFoldersDiffer(a, [{ path: sub, depth: 3 }])).toBe(true);
  });
});
