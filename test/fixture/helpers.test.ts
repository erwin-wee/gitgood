import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';
import { Store } from '../../src/main/store';

describe.skipIf(!hasGitSync())('createRepo fixture helper', () => {
  let repo: TestRepo | undefined;

  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('creates a repository with deterministic commits and removes it on dispose', async () => {
    repo = await createRepo({ commits: [{ message: 'first', files: { 'a.txt': 'one' } }, { message: 'second', files: { 'a.txt': 'two' } }] });
    expect(existsSync(repo.path)).toBe(true);
    const log = repo.git(['log', '--format=%s']).trim().split('\n');
    expect(log).toEqual(['second', 'first']);
    expect(await readFile(`${repo.path}/a.txt`, 'utf8')).toBe('two');
    const identity = repo.git(['config', '--get', 'user.email']).trim();
    expect(identity).toBe('test@example.com');
    // Never touches the real global config: the isolated HOME has none.
    const globalConfigCheck = repo.git(['config', '--global', '--list'], repo.path).trim();
    expect(globalConfigCheck).toBe('');

    const root = repo.root;
    await repo.dispose();
    expect(existsSync(root)).toBe(false);
    repo = undefined;
  });

  it('creates a bare origin and pushes commits when remote is requested', async () => {
    repo = await createRepo({ commits: [{ message: 'first', files: { 'a.txt': 'one' } }], remote: true });
    expect(repo.remotePath).toBeTruthy();
    const remoteLog = repo.git(['log', '--format=%s', 'main'], repo.remotePath!).trim();
    expect(remoteLog).toBe('first');
  });
});

describe.skipIf(!hasGitSync())('store.ts under the fixture electron mock', () => {
  it('loads settings and round-trips a value through the isolated userData directory', async () => {
    const repo = await createRepo();
    const store = new Store(`${repo.root}/userdata`);
    store.load();
    expect(store.getSettings().theme).toBe('system');
    store.updateSettings({ theme: 'dark' });
    expect(store.getSettings().theme).toBe('dark');
    await repo.dispose();
  });

  it('loads the notifications inbox settings with their defaults', async () => {
    const repo = await createRepo();
    const store = new Store(`${repo.root}/userdata`);
    store.load();
    const settings = store.getSettings();
    expect(settings.notificationsEnabled).toBe(true);
    expect(settings.notificationsPollIntervalMinutes).toBe(2);
    expect(settings.notifyMentions).toBe(true);
    expect(settings.notifyReviewRequests).toBe(true);
    store.updateSettings({ notificationsPollIntervalMinutes: 5, notifyMentions: false });
    expect(store.getSettings().notificationsPollIntervalMinutes).toBe(5);
    expect(store.getSettings().notifyMentions).toBe(false);
    await repo.dispose();
  });

  it('round-trips the inbox cache and clears it on request', async () => {
    const repo = await createRepo();
    const dir = `${repo.root}/userdata`;
    const store = new Store(dir);
    store.load();
    expect(store.getInboxCache()).toEqual({ items: [], lastModified: null, lastPolledAt: null });
    const item = { id: '1', threadId: '1', repo: { host: 'github.com', owner: 'octo', name: 'repo', url: 'https://github.com/octo/repo' }, localRepoId: null, subject: { type: 'PullRequest' as const, title: 'Add feature', url: 'https://github.com/octo/repo/pull/1', number: 1 }, reason: 'review_requested' as const, unread: true, updatedAt: '2026-01-01T00:00:00Z', lastReadAt: null };
    store.setInboxCache({ items: [item], lastModified: 'L1', lastPolledAt: '2026-01-01T00:00:00Z' });

    const restarted = new Store(dir);
    restarted.load();
    expect(restarted.getInboxCache()).toEqual({ items: [item], lastModified: 'L1', lastPolledAt: '2026-01-01T00:00:00Z' });

    restarted.clearInboxCache();
    expect(restarted.getInboxCache()).toEqual({ items: [], lastModified: null, lastPolledAt: null });
    const reloaded = new Store(dir);
    reloaded.load();
    expect(reloaded.getInboxCache()).toEqual({ items: [], lastModified: null, lastPolledAt: null });
    await repo.dispose();
  });

  it('persists an issue filter for one repository and reads it back after a restart', async () => {
    const repo = await createRepo();
    const dir = `${repo.root}/userdata`;
    const filter = { search: 'is:open', state: 'open' as const, assignee: 'me' as const, author: 'any' as const, mentioned: false, labels: ['bug'], milestone: null };

    const store = new Store(dir);
    store.load();
    expect(store.getIssueFilter('repo-1')).toBeNull();
    store.setIssueFilter('repo-1', filter);
    expect(store.getIssueFilter('repo-1')).toEqual(filter);

    // Simulate an app restart: a fresh Store instance reading the same directory.
    const restarted = new Store(dir);
    restarted.load();
    expect(restarted.getIssueFilter('repo-1')).toEqual(filter);
    expect(restarted.getIssueFilter('repo-2')).toBeNull();
    await repo.dispose();
  });
});
