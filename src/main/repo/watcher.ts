import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { log } from '../logger';

export type ChangeReason = 'worktree' | 'refs' | 'both';

const IGNORED_GIT_SEGMENTS = new Set(['objects', 'lfs', 'gitgood-rebase', 'modules']);
/** Top-level working-tree directories whose churn (installs, caches) never changes `git status` output worth a refresh. */
const IGNORED_WORKTREE_SEGMENTS = new Set(['node_modules', '__pycache__', '.cache', '.venv', '.idea']);
/** Trailing quiet time before one change notification; fs.watch already delivers ~250 ms late on Linux, so this stays short. */
const DEBOUNCE_MS = 120;

export interface RepositoryWatcherOptions {
  /**
   * The `.git` directory shared by every worktree of this repository
   * (`git rev-parse --git-common-dir`). Defaults to `gitDir`, i.e. this
   * worktree is the main one. When it differs, the common `refs/` directory
   * is watched too, so branches created in another worktree are noticed.
   */
  commonDir?: string;
  /** Polling interval in ms (default 4000); mainly for tests. */
  pollIntervalMs?: number;
  /** Skip native fs.watch entirely and use polling (deterministic; mainly for tests). */
  forcePolling?: boolean;
}

/**
 * Watches a repository for working tree and .git changes. Uses recursive
 * fs.watch (native on Windows/macOS, inotify-based on Linux) with a polling
 * fallback when the watcher cannot be created.
 */
export class RepositoryWatcher {
  private watcher: FSWatcher | null = null;
  private commonWatcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pending: ChangeReason | null = null;
  private lastPoll = new Map<string, number>();
  private paused = 0;
  private readonly commonDir: string;

  constructor(
    private readonly repoPath: string,
    private readonly gitDir: string,
    private readonly onChange: (reason: ChangeReason) => void,
    private readonly opts: RepositoryWatcherOptions = {},
  ) {
    this.commonDir = opts.commonDir ?? gitDir;
  }

  start(): void {
    if (this.opts.forcePolling) {
      this.startPolling();
      return;
    }
    try {
      this.watcher = watch(this.repoPath, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined) {
          this.schedule('both');
          return;
        }
        this.classify(String(filename));
      });
      this.watcher.on('error', (err) => {
        log.warn(`Watcher error for ${this.repoPath}: ${(err as Error).message}; falling back to polling`);
        this.stopWatcher();
        this.startPolling();
      });
      // The .git directory may live elsewhere (worktrees); watch it too.
      if (!this.gitDir.startsWith(this.repoPath + sep) && this.gitDir !== join(this.repoPath, '.git')) {
        const gitWatcher = watch(this.gitDir, { recursive: true, persistent: false }, (_e, filename) => this.classifyGit(String(filename ?? '')));
        gitWatcher.on('error', () => undefined);
        const original = this.watcher;
        this.watcher = {
          close: () => {
            original.close();
            gitWatcher.close();
          },
        } as unknown as FSWatcher;
      }
      // Linked worktree: HEAD/index live in the per-worktree admin dir above,
      // but branches/refs are shared in the common dir and are not covered by
      // it. Watch the common refs/ too, so ref changes made in any other
      // worktree are picked up here.
      if (this.commonDir !== this.gitDir) {
        try {
          this.commonWatcher = watch(join(this.commonDir, 'refs'), { recursive: true, persistent: false }, () => this.schedule('refs'));
          this.commonWatcher.on('error', () => undefined);
        } catch {
          /* the polling fallback below also covers the common refs/ and packed-refs */
        }
      }
    } catch (err) {
      log.warn(`Cannot watch ${this.repoPath} (${(err as Error).message}); using polling`);
      this.startPolling();
    }
  }

  /** Temporarily suppress change events (e.g. while we run our own git commands). */
  pause(): void {
    this.paused++;
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
  }

  private classify(filename: string): void {
    const normalized = filename.split(sep).join('/');
    if (normalized === '.git' || normalized.startsWith('.git/')) {
      this.classifyGit(normalized.replace(/^\.git\/?/, ''));
      return;
    }
    const slash = normalized.indexOf('/');
    if (IGNORED_WORKTREE_SEGMENTS.has(slash === -1 ? normalized : normalized.slice(0, slash))) return;
    this.schedule('worktree');
  }

  private classifyGit(relPath: string): void {
    const parts = relPath.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) {
      this.schedule('refs');
      return;
    }
    if (IGNORED_GIT_SEGMENTS.has(parts[0])) return;
    const last = parts[parts.length - 1];
    if (last.endsWith('.lock') || last.startsWith('tmp_') || last === 'index.lock') return;
    if (last === 'index') {
      this.schedule('worktree');
      return;
    }
    this.schedule('refs');
  }

  private schedule(reason: ChangeReason): void {
    if (this.paused > 0) return;
    this.pending = this.pending === null || this.pending === reason ? reason : 'both';
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const r = this.pending ?? 'both';
      this.pending = null;
      this.timer = null;
      this.onChange(r);
    }, DEBOUNCE_MS);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const targets = ['HEAD', 'index', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'packed-refs', join('refs', 'heads'), join('logs', 'HEAD')].map((f) => join(this.gitDir, f));
    if (this.commonDir !== this.gitDir) {
      targets.push(join(this.commonDir, 'packed-refs'), join(this.commonDir, 'refs', 'heads'));
    }
    this.pollTimer = setInterval(async () => {
      let changed = false;
      for (const t of targets) {
        try {
          const s = await stat(t);
          const prev = this.lastPoll.get(t);
          if (prev !== undefined && prev !== s.mtimeMs) changed = true;
          this.lastPoll.set(t, s.mtimeMs);
        } catch {
          if (this.lastPoll.has(t)) {
            changed = true;
            this.lastPoll.delete(t);
          }
        }
      }
      if (changed) this.schedule('both');
      else this.schedule('worktree');
    }, this.opts.pollIntervalMs ?? 4000);
  }

  private stopWatcher(): void {
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
    try {
      this.commonWatcher?.close();
    } catch {
      /* ignore */
    }
    this.commonWatcher = null;
  }

  stop(): void {
    this.stopWatcher();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  static relativeInside(root: string, p: string): boolean {
    const rel = relative(root, p);
    return !!rel && !rel.startsWith('..');
  }
}
