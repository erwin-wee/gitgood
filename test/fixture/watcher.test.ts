import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryWatcher, type ChangeReason } from '../../src/main/repo/watcher';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

// Integration tests use real fs.watch and a separate worker event loop; parent fake
// timers cannot advance it. Delays below bound observation of suppressed events.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasGitSync())('repository watcher', () => {
  let repo: TestRepo;
  let watcher: RepositoryWatcher | undefined;
  const events: ChangeReason[] = [];

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    await repo?.dispose();
    events.length = 0;
  });

  async function start(forcePolling = false) {
    watcher = new RepositoryWatcher(repo.path, join(repo.path, '.git'), (reason) => events.push(reason), {
      gitPath: repo.gitBin, env: repo.env, pollIntervalMs: 200, forcePolling,
    });
    await watcher.start();
  }

  async function changed() {
    await expect.poll(() => events.includes('worktree') || events.includes('both'), { timeout: 8000 }).toBe(true);
    events.length = 0;
  }

  it('ignores atomic cache writes but retains tracked files inside ignored trees', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'cache/tracked.txt': 'one', '.gitignore': '' } }] });
    await repo.write('.gitignore', '/cache/\n/new-cache/\n');
    await start();
    for (let i = 0; i < 100; i++) {
      const temp = join(repo.path, 'cache', `${i}.tmp`);
      await writeFile(temp, 'cache');
      await rename(temp, join(repo.path, 'cache', `${i}.json`));
    }
    await repo.write('new-cache/nested/output.json', 'ignored');
    await sleep(700);
    expect(events).toEqual([]);
    await repo.write('cache/tracked.txt', 'two');
    await changed();
    await repo.write('cache/tracked.txt', 'six'); // Still modified; same size as the previous edit.
    await changed();
  });

  it('honors nested negation, info/exclude and global ignores, including rule changes', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: {
      '.gitignore': '*.log\n', 'nested/.gitignore': '!keep.log\n', 'tracked.txt': 'one',
    } }] });
    await writeFile(join(repo.root, 'global-ignore'), '*.global\n');
    repo.git(['config', 'core.excludesFile', join(repo.root, 'global-ignore')]);
    await writeFile(join(repo.path, '.git/info/exclude'), '*.local\n');
    await start();
    await repo.write('nested/drop.log', 'ignored');
    await repo.write('a.global', 'ignored');
    await repo.write('b.local', 'ignored');
    await sleep(700);
    expect(events).toEqual([]);
    await repo.write('nested/keep.log', 'visible');
    await changed();
    await repo.write('nested/.gitignore', '');
    await changed();
    await repo.write('nested/keep.log', 'now ignored');
    await sleep(700);
    expect(events).toEqual([]);
    await writeFile(join(repo.root, 'global-ignore'), '');
    await changed(); // Existing a.global becomes visible without an event in the repository.
  });

  it('reconciles empty directories, deletions, index changes and repeat edits while polling', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'tracked.txt': 'one' } }] });
    await mkdir(join(repo.path, 'empty/nested'), { recursive: true });
    await start(true);
    await repo.write('empty/nested/new.txt', 'new');
    await changed();
    await repo.write('tracked.txt', 'two');
    await changed();
    await repo.write('tracked.txt', 'six');
    await changed();
    repo.git(['add', 'tracked.txt']);
    await changed();
    await rm(join(repo.path, 'empty'), { recursive: true });
    await changed();
  });

  it('suppresses paused and stopped notifications without leaving startup pending', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'tracked.txt': 'one' } }] });
    await start();
    watcher!.pause();
    watcher!.pause();
    await repo.write('tracked.txt', 'two');
    await sleep(700);
    watcher!.resume();
    await repo.write('tracked.txt', 'six');
    await sleep(700);
    expect(events).toEqual([]);
    watcher!.resume();
    await repo.write('tracked.txt', 'ten');
    await changed();
    await watcher!.stop();
    await repo.write('tracked.txt', 'end');
    await sleep(500);
    expect(events).toEqual([]);
    const starting = watcher!.start();
    const settled = expect(starting).rejects.toThrow();
    await watcher!.stop();
    await settled;
  });
});
