import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientContext } from '../../src/main/core/client-context';
import { GitClient } from '../../src/main/git/git';
import { RepositoryManager } from '../../src/main/repo/manager';
import { Store } from '../../src/main/store';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

// Real fs.watch in a worker thread: fake timers cannot drive it, and "no event" can only be observed over a bounded wait.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// Server mode: several clients share one RepositoryManager; each one's open repository must keep its live updates.
describe.skipIf(!hasGitSync())('repository watching per client', () => {
  const repos: TestRepo[] = [];
  let manager: RepositoryManager | undefined;
  const changed: string[] = [];

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    changed.length = 0;
    await Promise.all(repos.splice(0).map((r) => r.dispose()));
  });

  async function setup(): Promise<[TestRepo, TestRepo]> {
    const one = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const two = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    repos.push(one, two);
    const store = new Store(join(one.root, 'userdata'));
    store.load();
    manager = new RepositoryManager(store, new GitClient(one.tools()), (event, payload) => {
      if (event === 'repo.changed' && payload && typeof payload === 'object' && 'repoPath' in payload && typeof payload.repoPath === 'string') changed.push(payload.repoPath);
    });
    return [one, two];
  }

  const as = <T>(client: string, fn: () => Promise<T> | T): Promise<T> => Promise.resolve(clientContext.run(client, fn));

  async function expectChange(repo: TestRepo, content: string): Promise<void> {
    changed.length = 0;
    await repo.write('a.txt', content);
    await expect.poll(() => changed.includes(repo.path), { timeout: 8000 }).toBe(true);
  }

  async function expectNoChange(repo: TestRepo, content: string): Promise<void> {
    changed.length = 0;
    await repo.write('a.txt', content);
    await sleep(1500);
    expect(changed).not.toContain(repo.path);
  }

  it("keeps a client's repository watched while another client opens and switches repositories", async () => {
    const [one, two] = await setup();
    await as('phone', () => manager!.open(one.path));
    await as('desktop', () => manager!.open(two.path));
    await expectChange(one, '2\n'); // the desktop opening another repository did not stop the phone's watcher

    await as('desktop', () => manager!.open(one.path));
    await as('phone', () => manager!.release(one.path));
    await expectChange(one, '3\n'); // still wanted by the desktop
    await expectNoChange(two, '2\n'); // the desktop left it and nobody else has it open

    await as('desktop', () => manager!.releaseClient('desktop'));
    await expectNoChange(one, '4\n');
  });
});
