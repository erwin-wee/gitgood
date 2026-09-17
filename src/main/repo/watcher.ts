import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { log } from '../logger';

export type ChangeReason = 'worktree' | 'refs' | 'both';

const IGNORED_GIT_SEGMENTS = new Set(['objects', 'lfs', 'gitgood-rebase', 'modules']);

/**
 * Watches a repository for working tree and .git changes. Uses recursive
 * fs.watch (native on Windows/macOS, inotify-based on Linux) with a polling
 * fallback when the watcher cannot be created.
 */
export class RepositoryWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pending: ChangeReason | null = null;
  private lastPoll = new Map<string, number>();
  private paused = 0;

  constructor(
    private readonly repoPath: string,
    private readonly gitDir: string,
    private readonly onChange: (reason: ChangeReason) => void,
  ) {}

  start(): void {
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
    }, 350);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const targets = ['HEAD', 'index', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'packed-refs', join('refs', 'heads'), join('logs', 'HEAD')].map((f) => join(this.gitDir, f));
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
    }, 4000);
  }

  private stopWatcher(): void {
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
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
