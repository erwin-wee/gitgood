import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, normalize, resolve } from 'node:path';
import type { EventPayloads } from '@shared/ipc';
import type { GitHubRepoRef, RepositoryInfo, RepoWork } from '@shared/types';
import { parseRemoteUrl } from '@shared/util';
import { getBranches } from '../git/branches';
import type { GitClient } from '../git/git';
import { getRemotes, getStashes, getTopLevel } from '../git/operations';
import { getGitDir, getStatus } from '../git/status';
import { getCommonDir, getMainWorktreePath, listWorktrees } from '../git/worktree';
import { log } from '../logger';
import type { Store } from '../store';
import { RepositoryWatcher } from './watcher';

function normalizeForCompare(path: string): string {
  const n = normalize(path);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

const DERIVED_WORKTREES_TTL_MS = 10_000;

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

  /**
   * The stored repositories plus, for every main repository, any git
   * worktrees found on disk that were never explicitly added (e.g. created
   * outside GitGood). Worktrees explicitly added or created through GitGood
   * are already persisted (with `worktreeOf` set) and are not duplicated.
   */
  async list(fresh = true): Promise<RepositoryInfo[]> {
    if (fresh) this.invalidateWorktrees();
    const stored = this.store.getRepositories().map((r) => ({ ...r, missing: !existsSync(r.path) }));
    const derived = await this.deriveWorktreeChildren(stored);
    return [...stored, ...derived].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** `git worktree list` output per main repository, cached briefly so that event-driven list(false) calls are not a git run per repository each time. */
  private derivedCache = new Map<string, { at: number; worktrees: Awaited<ReturnType<typeof listWorktrees>> }>();

  private async cachedWorktrees(mainPath: string): Promise<Awaited<ReturnType<typeof listWorktrees>>> {
    const hit = this.derivedCache.get(mainPath);
    if (hit && Date.now() - hit.at < DERIVED_WORKTREES_TTL_MS) return hit.worktrees;
    const worktrees = await listWorktrees(this.git, mainPath);
    this.derivedCache.set(mainPath, { at: Date.now(), worktrees });
    return worktrees;
  }

  /** Forgets cached worktree listings; call after anything that adds or removes a worktree. */
  invalidateWorktrees(): void {
    this.derivedCache.clear();
  }

  private async deriveWorktreeChildren(stored: RepositoryInfo[]): Promise<RepositoryInfo[]> {
    const known = new Set(stored.map((r) => normalizeForCompare(r.path)));
    const mains = stored.filter((r) => !r.worktreeOf && !r.missing);
    const results: RepositoryInfo[] = [];
    await Promise.all(
      mains.map(async (main) => {
        try {
          const worktrees = await this.cachedWorktrees(main.path);
          for (const w of worktrees) {
            if (w.isMain) continue;
            const norm = normalizeForCompare(w.path);
            if (known.has(norm)) continue;
            known.add(norm);
            results.push({
              id: repositoryId(w.path),
              path: w.path,
              name: w.branch ?? `${basename(w.path)} (detached)`,
              alias: null,
              missing: !existsSync(w.path),
              github: main.github,
              lastOpened: main.lastOpened,
              indicator: null,
              worktreeOf: main.id,
              parentRepoId: null,
            });
          }
        } catch {
          /* not a repository with worktree support, git too old, or path gone */
        }
      }),
    );
    return results;
  }

  /** Determines whether `repoPath` is a linked worktree, returning the id of its main repository (registering it if needed). */
  private async resolveWorktreeOf(repoPath: string): Promise<string | null> {
    try {
      const mainPath = await getMainWorktreePath(this.git, repoPath);
      if (!mainPath || repositoryId(mainPath) === repositoryId(repoPath)) return null;
      const mainInfo = this.getByPath(mainPath) ?? (await this.add(mainPath));
      return mainInfo.id;
    } catch {
      return null;
    }
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
    this.invalidateWorktrees();
    const worktreeOf = await this.resolveWorktreeOf(repoPath);
    const github = await this.detectGitHub(repoPath, true);
    const info: RepositoryInfo = { id, path: repoPath, name: basename(repoPath), alias: null, missing: false, github, lastOpened: Date.now(), indicator: null, worktreeOf, parentRepoId: null };
    this.store.saveRepositories([...this.store.getRepositories(), info]);
    this.send('repos.changed', await this.list(false));
    return info;
  }

  /** Registers (or reuses) the repository at `submodulePath` and links it under `parentId`, nesting it in the repository list next to worktrees. */
  async openSubmodule(parentId: string, submodulePath: string): Promise<RepositoryInfo> {
    const info = await this.getOrAdd(resolve(submodulePath));
    if (info.parentRepoId === parentId) return info;
    const updated: RepositoryInfo = { ...info, parentRepoId: parentId };
    this.store.saveRepositories(this.store.getRepositories().map((r) => (r.id === info.id ? updated : r)));
    this.send('repos.changed', await this.list(false));
    return updated;
  }

  /** Removes a repository from the list. If it is a main repository, any of its worktrees that were explicitly registered are removed too (their directories are left untouched). */
  async remove(id: string): Promise<RepositoryInfo | null> {
    const repo = this.get(id);
    if (!repo) return null;
    this.invalidateWorktrees();
    const children = this.store.getRepositories().filter((r) => r.worktreeOf === id);
    for (const child of children) this.stopWatching(child.path);
    this.stopWatching(repo.path);
    this.store.saveRepositories(this.store.getRepositories().filter((r) => r.id !== id && r.worktreeOf !== id));
    this.send('repos.changed', await this.list(false));
    return repo;
  }

  /** Repositories (registered or derived) that are worktrees of the given main repository. */
  async worktreeChildren(id: string): Promise<RepositoryInfo[]> {
    return (await this.list()).filter((r) => r.worktreeOf === id);
  }

  async setAlias(id: string, alias: string | null): Promise<void> {
    this.store.saveRepositories(this.store.getRepositories().map((r) => (r.id === id ? { ...r, alias: alias?.trim() || null } : r)));
    this.send('repos.changed', await this.list(false));
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
    this.send('repos.changed', await this.list(false));
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
      const commonDir = await getCommonDir(this.git, repoPath).catch(() => gitDir);
      const watcher = new RepositoryWatcher(repoPath, gitDir, (reason) => this.send('repo.changed', { repoPath, reason }), { commonDir });
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
    // Derived (unregistered) worktrees are not persisted, so their indicators
    // are computed fresh here rather than cached across refreshes.
    const list = await this.list(false);
    const withDerivedIndicators = await Promise.all(
      list.map(async (r) => {
        if (!r.worktreeOf || r.missing || updated.some((u) => u.id === r.id)) return r;
        try {
          const status = await getStatus(this.git, r.path);
          return { ...r, indicator: { ahead: status.branch.ahead, behind: status.branch.behind, hasChanges: status.files.length > 0 } };
        } catch {
          return r;
        }
      }),
    );
    this.send('repos.changed', withDerivedIndicators);
    return withDerivedIndicators;
  }

  /**
   * Unpushed work (ahead/unpublished branches, stashes, uncommitted changes)
   * across every registered repository that exists on disk, for the
   * Unpushed work health card and the Welcome screen. Scans with bounded
   * concurrency so a large repository list never fans out into dozens of
   * concurrent git processes at once; repositories that fail (e.g. corrupt)
   * are silently skipped, like `refreshIndicators`.
   */
  async work(): Promise<RepoWork[]> {
    const concurrency = 3;
    const repos = (await this.list(false)).filter((r) => !r.missing);
    const results: RepoWork[] = [];
    for (let i = 0; i < repos.length; i += concurrency) {
      const batch = repos.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (r): Promise<RepoWork | null> => {
          try {
            const [branches, stashes, status] = await Promise.all([getBranches(this.git, r.path), getStashes(this.git, r.path), getStatus(this.git, r.path)]);
            const local = branches.filter((b) => b.kind === 'local');
            return {
              repoId: r.id,
              repoPath: r.path,
              repoName: r.alias ?? r.name,
              aheadBranches: local.filter((b) => (b.ahead ?? 0) > 0).map((b) => ({ name: b.name, ahead: b.ahead ?? 0 })),
              unpublishedBranches: local.filter((b) => b.unpublished).map((b) => b.name),
              stashCount: stashes.length,
              uncommittedCount: status.files.length,
            };
          } catch {
            return null;
          }
        }),
      );
      for (const r of batchResults) if (r) results.push(r);
    }
    return results;
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
  }
}
