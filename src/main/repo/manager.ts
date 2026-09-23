import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join, normalize, resolve } from 'node:path';
import type { EventPayloads } from '@shared/ipc';
import { repositoryOrigin, type GitHubRepoRef, type RepositoryInfo, type RepoWork } from '@shared/types';
import { mapWithConcurrency, parseRemoteUrl } from '@shared/util';
import { getBranches } from '../git/branches';
import { currentClient } from '../core/client-context';
import type { GitClient } from '../git/git';
import { getRemotes, getStashes, getTopLevel } from '../git/operations';
import { getGitDir, getStatus } from '../git/status';
import { getCommonDir, getMainWorktreePath, listWorktrees } from '../git/worktree';
import { log } from '../logger';
import type { Store } from '../store';
import { canonicalPath, isInside, normalizePath } from './paths';
import { RepositoryWatcher } from './watcher';

const normalizeForCompare = normalizePath;

const DERIVED_WORKTREES_TTL_MS = 10_000;

export type EventSender = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;

/** How a repository registered on another one's behalf (a worktree's main) should be recorded. */
interface ImplicitAddOptions {
  /** The caller is a watched-folder scan: honour exclusions and mark ownership by location. */
  discovered?: boolean;
  /** Collects the ids this call registered, so the scan reports exactly what it did. */
  registered?: Set<string>;
}

export interface AddManyResult {
  added: RepositoryInfo[];
  /** Found but already in the list, or excluded by the user. */
  skipped: number;
  /** Found but could not be registered (not a repository any more, or git failed). */
  failed: number;
}

/**
 * The key two paths are compared on to decide whether they are the same
 * repository: the working tree root with symbolic links resolved, so a
 * repository listed under `~/code/gitgood` is recognised when a scan reaches
 * it as `~/Projects/erwin-wee/gitgood`. Falls back to the normalized path when
 * the folder is gone or unreadable, so a missing repository never blocks an add.
 *
 * Deliberately not the `.git` common directory: a linked worktree shares its
 * main repository's common dir, and the two must stay separate entries.
 */
export async function resolvedKey(path: string): Promise<string> {
  return normalizePath(await canonicalPath(path));
}

/** A folder that still holds a `.git` entry of either kind; the same test the scan walker applies. */
function isRepositoryOnDisk(path: string): boolean {
  return existsSync(path) && existsSync(join(path, '.git'));
}

/**
 * Deliberately NOT normalizePath: this hash is a persisted identity (state.json
 * keys issue filters and repository-config trust by it), so its input must keep
 * hashing exactly as it always has. Use normalizePath/samePath to *compare*.
 */
export function repositoryId(path: string): string {
  const normalized = process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

export class RepositoryManager {
  private watchers = new Map<string, RepositoryWatcher>();
  private githubCache = new Map<string, GitHubRepoRef | null>();
  /** Repository each client is watching; the desktop app is the single '' client. */
  private watching = new Map<string, string>();
  /** Paths whose watcher is being set up, so a second client opening the same repository does not start a duplicate. */
  private starting = new Set<string>();

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

  /**
   * Determines whether `repoPath` is a linked worktree, returning the id of its
   * main repository (registering it if needed).
   *
   * `origin` is carried through to a main repository registered here: when a
   * scan reaches a worktree before its main, the main is discovered by that
   * scan too, and must not be recorded as if the user had added it by hand.
   */
  private async resolveWorktreeOf(repoPath: string, opts: ImplicitAddOptions = {}): Promise<string | null> {
    try {
      const mainPath = await getMainWorktreePath(this.git, repoPath);
      if (!mainPath || repositoryId(mainPath) === repositoryId(repoPath)) return null;
      const existing = this.getByPath(mainPath);
      if (existing) return existing.id;

      // Registering a main implicitly must honour the same rules addMany
      // applies to its own candidates, or a scan quietly reinstates a
      // repository the user removed. It is only the scanner's to own when it
      // actually lies in a watched folder.
      if (opts.discovered) {
        if (await this.isExcluded(mainPath)) return null;
        const inWatched = await this.isInWatchedFolder(mainPath);
        const info = await this.add(mainPath, { origin: inWatched ? 'watched' : 'manual', recordOpen: false });
        opts.registered?.add(info.id);
        return info.id;
      }
      const info = await this.add(mainPath);
      opts.registered?.add(info.id);
      return info.id;
    } catch {
      return null;
    }
  }

  /** Excluded by the path as stored, or by where it physically is (exclusions predating canonical storage). */
  private async isExcluded(path: string): Promise<boolean> {
    if (this.store.isRepositoryExcluded(path)) return true;
    return this.store.isRepositoryExcluded(await canonicalPath(path));
  }

  get(id: string): RepositoryInfo | null {
    return this.store.getRepositories().find((r) => r.id === id) ?? null;
  }

  getByPath(path: string): RepositoryInfo | null {
    const id = repositoryId(path);
    return this.get(id);
  }

  /**
   * Adds one repository, as the user asking for it. `origin: 'watched'` marks
   * it as discovered instead and leaves `lastOpened` unset, so a repository
   * registered on a scan's behalf does not jump the recently-opened ordering.
   */
  async add(path: string, opts: { origin?: 'manual' | 'watched'; recordOpen?: boolean } = {}): Promise<RepositoryInfo> {
    const resolved = resolve(path);
    const top = await getTopLevel(this.git, resolved);
    if (!top) throw new Error(`"${resolved}" is not a Git repository.`);
    const repoPath = process.platform === 'win32' ? normalize(top) : top;
    const id = repositoryId(repoPath);
    const existing = this.get(id);
    // `recordOpen` is what separates "the user asked for this repository" from
    // "a scan registered it on the way past": only the former counts as opening.
    const recordOpen = opts.recordOpen ?? true;
    if (existing) {
      if (recordOpen) this.touch(id);
      return existing;
    }
    this.invalidateWorktrees();
    const discovered = opts.origin === 'watched';
    const worktreeOf = await this.resolveWorktreeOf(repoPath, { discovered, registered: undefined });
    const github = await this.detectGitHub(repoPath, true);
    const info: RepositoryInfo = { id, path: repoPath, name: basename(repoPath), alias: null, missing: false, github, lastOpened: recordOpen ? Date.now() : 0, indicator: null, worktreeOf, parentRepoId: null, ...(discovered ? { origin: 'watched' as const } : {}) };
    this.store.saveRepositories([...this.store.getRepositories(), info]);
    this.send('repos.changed', await this.list(false));
    return info;
  }

  /**
   * Registers several repositories in one pass, for a watched-folder scan.
   *
   * Unlike `add()` this resolves with bounded concurrency, writes once and
   * sends a single `repos.changed`, so a folder holding dozens of clones does
   * not fan out into a git process and a full list broadcast per repository.
   *
   * Paths already in the list (compared by resolved location, see
   * `resolvedKey`) and paths the user has excluded are skipped; the entries
   * that are added are marked `origin: 'watched'`. Existing entries are left
   * exactly as they are, keeping their origin, alias and lastOpened.
   */
  async addMany(paths: string[], opts: { concurrency?: number } = {}): Promise<AddManyResult> {
    const concurrency = opts.concurrency ?? 3;
    const before = this.store.getRepositories();
    const beforeIds = new Set(before.map((r) => r.id));
    /** Ids this call registered, directly or through resolveWorktreeOf. */
    const claimed = new Set<string>();
    /** Resolved keys of repositories already in the list. */
    const known = new Set(await Promise.all(before.map((r) => resolvedKey(r.path))));
    const candidates: { path: string; key: string }[] = [];
    let skipped = 0;
    let failed = 0;

    for (const path of paths) {
      const resolvedPath = resolve(path);
      if (await this.isExcluded(resolvedPath)) {
        skipped++;
        continue;
      }
      const key = await resolvedKey(resolvedPath);
      // `known` grows with each claimed candidate, so two paths that resolve to
      // the same repository in one call only produce one entry.
      if (known.has(key)) {
        skipped++;
        continue;
      }
      known.add(key);
      candidates.push({ path: resolvedPath, key });
    }
    if (!candidates.length) return { added: [], skipped, failed };

    this.invalidateWorktrees();
    const added: RepositoryInfo[] = [];
    for (let i = 0; i < candidates.length; i += concurrency) {
      const batch = candidates.slice(i, i + concurrency);
      const infos = await Promise.all(
        batch.map(async (candidate): Promise<RepositoryInfo | null | 'skip' | 'claimed'> => {
          try {
            const top = await getTopLevel(this.git, candidate.path);
            if (!top) return null;
            const repoPath = process.platform === 'win32' ? normalize(top) : top;
            const id = repositoryId(repoPath);
            // Already in the list *before* this call is a genuine skip; added
            // during it (a worktree's main, or a racing candidate) is this
            // call's own work and must not be counted as already known.
            if (this.get(id)) return beforeIds.has(id) ? 'skip' : 'claimed';
            // git reports the physical path, so the top level of a candidate
            // reached through a symlink differs from the candidate's own path
            // while denoting the same repository. Only a key that is neither
            // this candidate's own nor unclaimed means git resolved onto a
            // *different* repository (e.g. the candidate was a subdirectory).
            const key = await resolvedKey(repoPath);
            if (key !== candidate.key && known.has(key)) return 'skip';
            known.add(key);
            const worktreeOf = await this.resolveWorktreeOf(repoPath, { discovered: true, registered: claimed });
            const github = await this.detectGitHub(repoPath, true);
            return { id: repositoryId(repoPath), path: repoPath, name: basename(repoPath), alias: null, missing: false, github, lastOpened: 0, indicator: null, worktreeOf, parentRepoId: null, origin: 'watched' };
          } catch (err) {
            log.warn(`Could not add ${candidate.path} from a watched folder: ${(err as Error).message}`);
            return null;
          }
        }),
      );
      for (const info of infos) {
        if (info === 'skip') skipped++;
        else if (info === 'claimed') continue;
        else if (info === null) failed++;
        else added.push(info);
      }
    }

    // Re-read rather than reusing `before`: resolveWorktreeOf may itself have
    // registered a main repository while this ran, and two candidates in one
    // batch can race onto the same top level.
    const current = this.store.getRepositories();
    const stored = new Set(current.map((r) => r.id));
    const fresh: RepositoryInfo[] = [];
    for (const info of added) {
      if (stored.has(info.id)) {
        // Registered while this call ran (two candidates racing onto the same
        // top level, or resolveWorktreeOf); only a pre-existing entry counts
        // as skipped.
        if (beforeIds.has(info.id)) skipped++;
        continue;
      }
      stored.add(info.id);
      claimed.add(info.id);
      fresh.push(info);
    }
    if (fresh.length) {
      this.store.saveRepositories([...current, ...fresh]);
      this.send('repos.changed', await this.list(false));
    }
    // Exactly what this call registered — a repository another caller happened
    // to add while the scan ran is not the scan's to report.
    return { added: this.store.getRepositories().filter((r) => claimed.has(r.id)), skipped, failed };
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

  /**
   * Removes a repository from the list. If it is a main repository, any of its
   * worktrees that were explicitly registered are removed too (their
   * directories are left untouched).
   *
   * A repository that sits inside a watched folder is also recorded as
   * excluded, whatever its origin, so the next scan does not add it straight
   * back — otherwise removing it would visibly fail to stick. Removals outside
   * every watched folder record nothing.
   */
  async remove(id: string): Promise<RepositoryInfo | null> {
    const repo = this.get(id);
    if (!repo) return null;
    this.invalidateWorktrees();
    const children = this.store.getRepositories().filter((r) => r.worktreeOf === id);
    for (const child of children) this.stopWatching(child.path);
    this.stopWatching(repo.path);
    for (const r of [repo, ...children]) {
      if (!(await this.isInWatchedFolder(r.path))) continue;
      // Stored physically, like everything else the scan compares: an entry
      // held under a symlink path (a settings import does that) would
      // otherwise be re-added the moment a scan reached its real path.
      this.store.addExcludedRepositoryPath(await canonicalPath(r.path));
    }
    this.store.saveRepositories(this.store.getRepositories().filter((r) => r.id !== id && r.worktreeOf !== id));
    this.send('repos.changed', await this.list(false));
    return repo;
  }

  /**
   * True when `repoPath` lies within (or is) one of the registered watched
   * folders. Compared on physical paths: a repository's stored path comes from
   * git and has its symlinks resolved, so a watched folder registered before
   * paths were canonicalised (or hand-edited into settings.json) would
   * otherwise never match the repositories inside it.
   */
  async isInWatchedFolder(repoPath: string): Promise<boolean> {
    const folders = this.store.getSettings().watchedFolders;
    if (folders.some((f) => isInside(f.path, repoPath))) return true;
    const target = await canonicalPath(repoPath);
    const roots = await Promise.all(folders.map((f) => canonicalPath(f.path)));
    return roots.some((root) => isInside(root, target));
  }

  /**
   * Drops discovered repositories under `folderPath` whose folder is gone or is
   * no longer a repository, after a scan of that folder that completed cleanly.
   *
   * Only `origin: 'watched'` entries are candidates: dropping is the scanner
   * tidying up entries it created, so a repository the user added by hand stays
   * in the list and is shown as missing, exactly as it is today. Nothing is
   * excluded — the repository is gone, not refused.
   *
   * `unreadable` carries the directories that scan could not read; a repository
   * beneath one of them is left alone, so an unmounted drive or a permissions
   * change never silently empties the list. The caller must not invoke this at
   * all for a cancelled scan.
   */
  async dropVanished(folderPath: string, unreadable: string[]): Promise<RepositoryInfo[]> {
    const stored = this.store.getRepositories();
    const dropped = stored.filter(
      (r) =>
        repositoryOrigin(r) === 'watched' &&
        isInside(folderPath, r.path) &&
        !unreadable.some((u) => isInside(u, r.path)) &&
        !isRepositoryOnDisk(r.path),
    );
    if (!dropped.length) return [];
    const ids = new Set(dropped.map((r) => r.id));

    // A dropped main takes its *discovered* worktree children with it (they
    // are gone with it), but never a child the user added by hand, and never
    // one that is still on disk. Survivors are re-parented to the top level:
    // an entry whose `worktreeOf` points at a repository no longer in the list
    // would be nested under nothing and disappear from the sidebar.
    const orphans = stored.filter((r) => r.worktreeOf && ids.has(r.worktreeOf) && !ids.has(r.id));
    const alsoDropped = orphans.filter(
      (r) =>
        repositoryOrigin(r) === 'watched' &&
        // Same guards as the primary set: a worktree living outside this
        // folder, or under a directory this scan could not read (an unmounted
        // drive), is not this scan's to judge — it is re-parented instead.
        isInside(folderPath, r.path) &&
        !unreadable.some((u) => isInside(u, r.path)) &&
        !isRepositoryOnDisk(r.path),
    );
    for (const r of alsoDropped) ids.add(r.id);
    const survivors = new Set(orphans.filter((r) => !ids.has(r.id)).map((r) => r.id));

    const all = [...dropped, ...alsoDropped];
    for (const r of all) this.stopWatching(r.path);
    this.invalidateWorktrees();
    this.store.saveRepositories(stored.filter((r) => !ids.has(r.id)).map((r) => (survivors.has(r.id) ? { ...r, worktreeOf: null } : r)));
    this.send('repos.changed', await this.list(false));
    return all;
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

  /**
   * Watches `repoPath` for the calling client (see core/client-context), which
   * watches one repository at a time: opening another releases its previous
   * one. A watcher stops once no client wants it, so on the server one client
   * switching repositories never stops another's live updates.
   */
  async watch(repoPath: string): Promise<void> {
    const owner = currentClient();
    const previous = this.watching.get(owner);
    this.watching.set(owner, repoPath);
    if (previous && previous !== repoPath) this.stopIfUnwanted(previous);
    if (this.watchers.has(repoPath) || this.starting.has(repoPath)) return;
    this.starting.add(repoPath);
    let watcher: RepositoryWatcher | undefined;
    try {
      const gitDir = await getGitDir(this.git, repoPath);
      const commonDir = await getCommonDir(this.git, repoPath).catch(() => gitDir);
      const gitPath = await this.git.executable();
      const env = await this.git.baseEnv();
      if (!this.wanted(repoPath)) return;
      watcher = new RepositoryWatcher(repoPath, gitDir, (reason) => this.send('repo.changed', { repoPath, reason }), { commonDir, gitPath, env });
      this.watchers.set(repoPath, watcher);
      await watcher.start();
    } catch (err) {
      if (watcher && this.watchers.get(repoPath) === watcher) this.watchers.delete(repoPath);
      if (watcher) void watcher.stop();
      if (this.wanted(repoPath)) log.warn(`Failed to watch ${repoPath}: ${(err as Error).message}`);
    } finally {
      this.starting.delete(repoPath);
    }
  }

  /** The calling client no longer shows `repoPath` (`repo.close`). */
  release(repoPath: string): void {
    const owner = currentClient();
    if (this.watching.get(owner) !== repoPath) return;
    this.watching.delete(owner);
    this.stopIfUnwanted(repoPath);
  }

  /** A server client disconnected for good: drop whatever it was watching. */
  releaseClient(owner: string): void {
    const repoPath = this.watching.get(owner);
    if (!repoPath) return;
    this.watching.delete(owner);
    this.stopIfUnwanted(repoPath);
  }

  /** Stops watching `repoPath` for every client (the repository was removed). */
  stopWatching(repoPath: string): void {
    for (const [owner, path] of this.watching) if (path === repoPath) this.watching.delete(owner);
    this.stopIfUnwanted(repoPath);
  }

  private wanted(repoPath: string): boolean {
    for (const path of this.watching.values()) if (path === repoPath) return true;
    return false;
  }

  private stopIfUnwanted(repoPath: string): void {
    if (this.wanted(repoPath)) return;
    void this.watchers.get(repoPath)?.stop();
    this.watchers.delete(repoPath);
  }

  pauseWatcher(repoPath: string): () => void {
    const w = this.watchers.get(repoPath);
    w?.pause();
    return () => w?.resume();
  }

  async refreshIndicators(): Promise<RepositoryInfo[]> {
    const repos = this.store.getRepositories();
    const updated = await mapWithConcurrency(repos, 3, async (repo): Promise<RepositoryInfo> => {
      if (!existsSync(repo.path)) return { ...repo, indicator: null };
      try {
        const status = await getStatus(this.git, repo.path);
        return { ...repo, indicator: { ahead: status.branch.ahead, behind: status.branch.behind, hasChanges: status.files.length > 0 } };
      } catch {
        return { ...repo, indicator: null };
      }
    });
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
    this.watching.clear();
    for (const w of this.watchers.values()) void w.stop();
    this.watchers.clear();
  }
}
