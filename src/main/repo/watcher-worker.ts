import { lstatSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { exec } from '../exec';
import type { WatcherData, WatcherMessage } from './watcher';

const port = parentPort!;
const { repoPath, gitDir, commonDir = gitDir, gitPath, env, pollIntervalMs = 4000, forcePolling } = workerData as WatcherData;
const abort = new AbortController();
const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
let native = !forcePolling;
let stopped = false;
let paused = 0;
let running = false;
let again = false;
let ready = false;
let lastError = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let worktree = new Map<string, string>();
let refs = new Map<string, string>();

function send(message: WatcherMessage): void {
  if (!stopped) port.postMessage(message);
}

function warn(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message !== lastError) send({ type: 'error', message });
  lastError = message;
}

function stat(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
}

function stamp(s: ReturnType<typeof stat>): string {
  return s ? `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : 'missing';
}

function addParents(file: string, root: string, directories: Set<string>): void {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (directories.has(dir)) break;
    directories.add(dir);
    if (dir === root || dir === dirname(dir)) break;
  }
}

async function git(args: string[]): Promise<string> {
  return (await exec(gitPath, ['-c', 'core.quotePath=false', '-c', 'core.longpaths=true', '--no-pager', ...args], {
    cwd: repoPath, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, signal: abort.signal, timeoutMs: 30000,
  })).stdout;
}

function differs(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.size !== after.size) return true;
  for (const [key, value] of after) if (before.get(key) !== value) return true;
  return false;
}

function schedule(): void {
  if (stopped) return;
  if (!running && !timer) {
    void scan();
    return;
  }
  if (timer) return;
  // Bound event bursts without postponing refresh indefinitely during continuous writes.
  timer = setTimeout(() => { timer = undefined; void scan(); }, 120);
}

function closeWatchers(): void {
  for (const { watcher } of watchers.values()) watcher.close();
  watchers.clear();
}

function updateWatchers(directories: Set<string>): void {
  if (!native || stopped) return;
  for (const [dir, entry] of watchers) {
    if (!directories.has(dir)) { entry.watcher.close(); watchers.delete(dir); }
  }
  for (const dir of directories) {
    const s = stat(dir);
    const identity = s?.isDirectory() ? `${s.dev}:${s.ino}` : '';
    const previous = watchers.get(dir);
    if (previous?.identity === identity) continue;
    previous?.watcher.close();
    watchers.delete(dir);
    if (!identity) continue;
    try {
      // Never use recursive fs.watch: on Linux its synchronous rescans amplify rename bursts.
      const watcher = watch(dir, { persistent: false }, schedule);
      watchers.set(dir, { watcher, identity });
      watcher.on('error', (err) => {
        if (stopped) return;
        native = false;
        closeWatchers();
        warn(new Error(`Native watch failed; using polling: ${err.message}`));
      });
    } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) continue;
      native = false;
      closeWatchers();
      warn(new Error(`Native watch unavailable; using polling: ${(err as Error).message}`));
      break;
    }
  }
}

async function scan(): Promise<void> {
  if (stopped) return;
  if (running) { again = true; return; }
  running = true;
  try {
    // Git handles nested/negated/global ignores and info/exclude. Cached paths retain
    // force-added files even when their containing tree is otherwise ignored.
    const files = await git(['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z']);
    const refList = await git(['for-each-ref', '--format=%(refname) %(objectname)']);
    if (stopped) return;
    const directories = new Set([repoPath, gitDir, commonDir]);
    const nextWorktree = new Map<string, string>();
    const nextRefs = new Map<string, string>();
    let hasSubmodules = false;
    for (const file of files.split('\0')) {
      if (!file) continue;
      const path = join(repoPath, file);
      const s = stat(path);
      nextWorktree.set(path, stamp(s));
      addParents(path, repoPath, directories);
      if (s?.isDirectory()) hasSubmodules = true;
    }
    nextWorktree.set(join(gitDir, 'index'), stamp(stat(join(gitDir, 'index'))));
    for (const base of new Set([gitDir, commonDir])) {
      for (const file of ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'packed-refs', 'config', 'info/exclude', 'logs/HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        const path = join(base, file);
        const s = stat(path);
        nextRefs.set(path, stamp(s));
        addParents(path, base, directories);
        if (s?.isDirectory()) directories.add(path);
      }
      for (const name of ['refs', 'refs/heads', 'refs/remotes', 'refs/tags']) directories.add(join(base, name));
    }
    for (const line of refList.split('\n')) {
      if (!line) continue;
      const space = line.indexOf(' ');
      const path = join(commonDir, line.slice(0, space));
      nextRefs.set(path, line.slice(space + 1));
      addParents(path, commonDir, directories);
    }
    updateWatchers(directories);
    // Gitlinks are directories, not their files in the superproject's index. Refresh
    // their dirty status on reconciliation without recursively subscribing to them.
    const workChanged = differs(worktree, nextWorktree) || hasSubmodules;
    const refsChanged = differs(refs, nextRefs);
    worktree = nextWorktree;
    refs = nextRefs;
    if (!ready) {
      ready = true;
      send({ type: 'ready' });
    } else if (!paused && (workChanged || refsChanged)) {
      send({ type: 'change', reason: workChanged && refsChanged ? 'both' : refsChanged ? 'refs' : 'worktree' });
    }
    lastError = '';
  } catch (err) {
    if (!stopped) warn(err);
    if (!ready) {
      stopped = true;
      clearInterval(poll);
      clearTimeout(timer);
      closeWatchers();
    }
  } finally {
    running = false;
    if (stopped) port.close();
    else if (again) { again = false; schedule(); }
  }
}

const poll = setInterval(schedule, pollIntervalMs);
port.on('message', (message: 'pause' | 'resume' | 'stop') => {
  if (message === 'pause') paused++;
  else if (message === 'resume') paused = Math.max(0, paused - 1);
  else {
    stopped = true;
    abort.abort();
    clearInterval(poll);
    clearTimeout(timer);
    closeWatchers();
    if (!running) port.close();
  }
});
void scan();
