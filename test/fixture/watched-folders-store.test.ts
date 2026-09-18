import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/main/store';
import { repositoryOrigin } from '../../src/shared/types';

const dirs: string[] = [];

async function withStore(fn: (store: Store, dir: string) => void | Promise<void>, seed?: (dir: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gg-watched-folders-'));
  dirs.push(dir);
  seed?.(dir);
  const store = new Store(dir);
  store.load();
  await fn(store, dir);
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('Store exclusions', () => {
  it('starts empty and records an exclusion once', async () => {
    await withStore((store) => {
      expect(store.getExcludedRepositoryPaths()).toEqual([]);
      store.addExcludedRepositoryPath(`${sep}a${sep}b`);
      store.addExcludedRepositoryPath(`${sep}a${sep}b`);
      expect(store.getExcludedRepositoryPaths()).toHaveLength(1);
      expect(store.isRepositoryExcluded(`${sep}a${sep}b`)).toBe(true);
    });
  });

  it('matches a path that differs only by a trailing separator', async () => {
    await withStore((store) => {
      store.addExcludedRepositoryPath(`${sep}a${sep}b`);
      expect(store.isRepositoryExcluded(`${sep}a${sep}b${sep}`)).toBe(true);
    });
  });

  it('folds case only on Windows', async () => {
    await withStore((store) => {
      store.addExcludedRepositoryPath(`${sep}A${sep}B`);
      expect(store.isRepositoryExcluded(`${sep}a${sep}b`)).toBe(process.platform === 'win32');
    });
  });

  it('removes and clears', async () => {
    await withStore((store) => {
      store.addExcludedRepositoryPath(`${sep}a`);
      store.addExcludedRepositoryPath(`${sep}b`);
      store.removeExcludedRepositoryPath(`${sep}a${sep}`);
      expect(store.isRepositoryExcluded(`${sep}a`)).toBe(false);
      expect(store.isRepositoryExcluded(`${sep}b`)).toBe(true);
      store.clearExcludedRepositoryPaths();
      expect(store.getExcludedRepositoryPaths()).toEqual([]);
    });
  });

  it('persists across a reload', async () => {
    await withStore(async (store, dir) => {
      store.addExcludedRepositoryPath(`${sep}a${sep}b`);
      const reopened = new Store(dir);
      reopened.load();
      expect(reopened.isRepositoryExcluded(`${sep}a${sep}b`)).toBe(true);
    });
  });
});

describe('legacy state and repository files', () => {
  it('loads a state.json written before watched folders existed', async () => {
    await withStore(
      (store) => {
        // The pre-existing keys survive and the new one reads as empty rather than undefined.
        expect(store.getState().currentRepositoryId).toBe('abc');
        expect(store.getExcludedRepositoryPaths()).toEqual([]);
        store.addExcludedRepositoryPath(`${sep}a`);
        expect(store.getExcludedRepositoryPaths()).toHaveLength(1);
      },
      (dir) => writeFileSync(join(dir, 'state.json'), JSON.stringify({ currentRepositoryId: 'abc', recentRepositoryIds: ['abc'], zoomLevel: 0 })),
    );
  });

  it('loads a repositories.json whose entries have no origin and treats them as manual', async () => {
    await withStore(
      (store) => {
        const repos = store.getRepositories();
        expect(repos).toHaveLength(1);
        expect(repos[0].origin).toBeUndefined();
        expect(repositoryOrigin(repos[0])).toBe('manual');
      },
      (dir) =>
        writeFileSync(
          join(dir, 'repositories.json'),
          JSON.stringify({ repositories: [{ id: 'abc', path: `${sep}repo`, name: 'repo', alias: null, missing: false, github: null, lastOpened: 1, indicator: null, worktreeOf: null, parentRepoId: null }] }),
        ),
    );
  });

  it('keeps watched folders and exclusions out of a settings export', async () => {
    await withStore((store) => {
      store.updateSettings({ watchedFolders: [{ path: `${sep}home${sep}me${sep}watched-secret`, depth: 3 }] });
      store.addExcludedRepositoryPath(`${sep}home${sep}me${sep}excluded-secret`);
      // A repository IS exported, so the export is not trivially empty: this
      // proves the two machine-local lists are withheld, not that nothing ships.
      const repo = { id: '1', path: `${sep}home${sep}me${sep}ordinary-repo`, name: 'ordinary-repo', alias: null, missing: false, github: null, lastOpened: 0, indicator: null, worktreeOf: null, parentRepoId: null };
      const json = JSON.stringify(store.buildExport(['preferences', 'repositories', 'integrations'], [repo]));

      expect(json).toContain('ordinary-repo');
      expect(json).not.toContain('watchedFolders');
      expect(json).not.toContain('excludedRepositoryPaths');
      expect(json).not.toContain('watched-secret');
      expect(json).not.toContain('excluded-secret');
    });
  });
});
