import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, normalize, resolve } from 'node:path';
import type { EventPayloads } from '@shared/ipc';
import type { GitHubRepoRef, RepositoryInfo } from '@shared/types';
import { parseRemoteUrl } from '@shared/util';
import type { GitClient } from '../git/git';
import { getRemotes, getTopLevel } from '../git/operations';
import { getGitDir, getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import { RepositoryWatcher } from './watcher';

export type EventSender = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;

export function repositoryId(path: string): string {
  const normalized = process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

export class RepositoryManager {
  private watchers = new Map<string, RepositoryWatcher>();
  private githubCache = new Map<string, GitHubRepoRef | null>();

  constructor(
    private readonly store: Store,
    private readonly git: GitClient,
    private readonly send: EventSender,
  ) {}

  list(): RepositoryInfo[] {
    const repos = this.store.getRepositories().map((r) => ({ ...r, missing: !existsSync(r.path) }));
    return repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  get(id: string): RepositoryInfo | null {
    return this.store.getRepositories().find((r) => r.id === id) ?? null;
  }

  getByPath(path: string): RepositoryInfo | null {
    const id = repositoryId(path);
    return this.get(id);
  }

  async add(path: string): Promise<RepositoryInfo> {
    const resolved = resolve(path);
    const top = await getTopLevel(this.git, resolved);
    if (!top) throw new Error(`"${resolved}" is not a Git repository.`);
    const repoPath = process.platform === 'win32' ? normalize(top) : top;
    const id = repositoryId(repoPath);
    const existing = this.get(id);
    if (existing) {
      this.touch(id);
      return existing;
    }
    const github = await this.detectGitHub(repoPath, true);
    const info: RepositoryInfo = { id, path: repoPath, name: basename(repoPath), alias: null, missing: false, github, lastOpened: Date.now(), indicator: null };
    this.store.saveRepositories([...this.store.getRepositories(), info]);
    this.send('repos.changed', this.list());
    return info;
  }

  remove(id: string): RepositoryInfo | null {
    const repo = this.get(id);
    if (!repo) return null;
    this.stopWatching(repo.path);
    this.store.saveRepositories(this.store.getRepositories().filter((r) => r.id !== id));
    this.send('repos.changed', this.list());
    return repo;
  }

  setAlias(id: string, alias: string | null): void {
    this.store.saveRepositories(this.store.getRepositories().map((r) => (r.id === id ? { ...r, alias: alias?.trim() || null } : r)));
    this.send('repos.changed', this.list());
  }

  touch(id: string): void {
    this.store.saveRepositories(this.store.getRepositories().map((r) => (r.id === id ? { ...r, lastOpened: Date.now() } : r)));
    const recent = [id, ...this.store.getState().recentRepositoryIds.filter((r) => r !== id)].slice(0, 10);
    this.store.updateState({ currentRepositoryId: id, recentRepositoryIds: recent });
  }

  async detectGitHub(repoPath: string, force = false): Promise<GitHubRepoRef | null> {
    if (!force && this.githubCache.has(repoPath)) return this.githubCache.get(repoPath)!;
    let ref: GitHubRepoRef | null = null;
    try {
      const remotes = await getRemotes(this.git, repoPath);
      const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
      if (origin) ref = parseRemoteUrl(origin.fetchUrl || origin.pushUrl);
    } catch (err) {
      log.warn(`Could not read remotes for ${repoPath}: ${(err as Error).message}`);
    }
    this.githubCache.set(repoPath, ref);
    return ref;
  }

  /** Re-reads the remote and persists the GitHub association (after publish / remote change). */
  async refreshGitHub(repoPath: string): Promise<GitHubRepoRef | null> {
    const ref = await this.detectGitHub(repoPath, true);
    const id = repositoryId(repoPath);
    this.store.saveRepositories(this.store.getRepositories().map((r) => (r.id === id ? { ...r, github: ref } : r)));
    this.send('repos.changed', this.list());
    return ref;
  }

  async open(path: string): Promise<RepositoryInfo> {
    const info = (await this.getOrAdd(path));
    this.touch(info.id);
    await this.watch(info.path);
    return { ...info, github: await this.detectGitHub(info.path) };
  }

  private async getOrAdd(path: string): Promise<RepositoryInfo> {
    return this.getByPath(path) ?? (await this.add(path));
  }

  async watch(repoPath: string): Promise<void> {
    if (this.watchers.has(repoPath)) return;
    // Only the active repository is watched; stop the others.
    for (const [p, w] of this.watchers) {
      if (p !== repoPath) {
        w.stop();
        this.watchers.delete(p);
      }
    }
    try {
      const gitDir = await getGitDir(this.git, repoPath);
      const watcher = new RepositoryWatcher(repoPath, gitDir, (reason) => this.send('repo.changed', { repoPath, reason }));
      watcher.start();
      this.watchers.set(repoPath, watcher);
    } catch (err) {
      log.warn(`Failed to watch ${repoPath}: ${(err as Error).message}`);
    }
  }

  stopWatching(repoPath: string): void {
    this.watchers.get(repoPath)?.stop();
    this.watchers.delete(repoPath);
  }

  pauseWatcher(repoPath: string): () => void {
    const w = this.watchers.get(repoPath);
    w?.pause();
    return () => w?.resume();
  }

  async refreshIndicators(): Promise<RepositoryInfo[]> {
    const repos = this.store.getRepositories();
    const updated: RepositoryInfo[] = [];
    for (const repo of repos) {
      if (!existsSync(repo.path)) {
        updated.push({ ...repo, indicator: null });
        continue;
      }
      try {
        const status = await getStatus(this.git, repo.path);
        updated.push({ ...repo, indicator: { ahead: status.branch.ahead, behind: status.branch.behind, hasChanges: status.files.length > 0 } });
      } catch {
        updated.push({ ...repo, indicator: null });
      }
    }
    this.store.saveRepositories(updated);
    const list = this.list();
    this.send('repos.changed', list);
    return list;
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
  }
}
