/// <reference types="electron-vite/node" />
import type { Worker } from 'node:worker_threads';
import { log } from '../logger';
import createWatcherWorker from './watcher-worker?nodeWorker';

export type ChangeReason = 'worktree' | 'refs' | 'both';

export interface RepositoryWatcherOptions {
  gitPath: string;
  env: NodeJS.ProcessEnv;
  commonDir?: string;
  pollIntervalMs?: number;
  forcePolling?: boolean;
}

export interface WatcherData extends RepositoryWatcherOptions {
  repoPath: string;
  gitDir: string;
}

export type WatcherMessage =
  | { type: 'ready' }
  | { type: 'change'; reason: ChangeReason }
  | { type: 'error'; message: string };

/** Main-thread owner only: enumeration, Git, stat calls and event coalescing live in the worker. */
export class RepositoryWatcher {
  private worker: Worker | null = null;
  private paused = 0;

  constructor(
    private readonly repoPath: string,
    private readonly gitDir: string,
    private readonly onChange: (reason: ChangeReason) => void,
    private readonly opts: RepositoryWatcherOptions,
  ) {}

  start(): Promise<void> {
    if (this.worker) throw new Error('Repository watcher already started');
    const worker = createWatcherWorker({ workerData: { ...this.opts, repoPath: this.repoPath, gitDir: this.gitDir } satisfies WatcherData });
    this.worker = worker;
    worker.unref();
    return new Promise((resolve, reject) => {
      let ready = false;
      worker.on('message', (message: WatcherMessage) => {
        if (this.worker !== worker) return;
        if (message.type === 'ready') {
          ready = true;
          resolve();
        } else if (message.type === 'error') {
          log.warn(`Watcher for ${this.repoPath}: ${message.message}`);
        } else if (this.paused === 0) {
          this.onChange(message.reason);
        }
      });
      worker.on('error', (err) => {
        if (this.worker === worker) log.error(`Repository watcher failed for ${this.repoPath}`, err);
        reject(err);
      });
      worker.once('exit', (code) => {
        if (this.worker === worker) {
          this.worker = null;
          log.warn(`Repository watcher exited for ${this.repoPath} (${code})`);
        }
        if (!ready) reject(new Error(`Repository watcher stopped before initialization (${code})`));
      });
    });
  }

  pause(): void {
    this.paused++;
    this.worker?.postMessage('pause');
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    this.worker?.postMessage('resume');
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    // Let the worker abort any Git child before terminating a stuck enumeration.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => void worker.terminate(), 2000);
      timer.unref();
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
      worker.postMessage('stop');
    });
  }
}
