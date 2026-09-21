import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const sharedAlias = { '@shared': resolve('src/shared'), './watcher-worker?nodeWorker': resolve('test/helpers/watcher-worker.ts') };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/fixture/**', 'test/smoke/**'],
          environment: 'node',
          // Several suites here (release notes, split, precommit review) build throwaway
          // repositories with the real `git` binary, which is slow enough on Windows CI to
          // blow the 5s default. Same allowance the fixture project makes.
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        resolve: { alias: { ...sharedAlias, electron: resolve('test/helpers/electron-mock.ts') } },
        test: {
          name: 'fixture',
          include: ['test/fixture/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: 'forks',
        },
      },
    ],
  },
});
