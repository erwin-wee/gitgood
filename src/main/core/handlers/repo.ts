import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { stageFiles } from '../../git/commit';
import * as ops from '../../git/operations';
import { log } from '../../logger';
import { canonicalPath } from '../../repo/paths';
import { addWatchedFolder, folderProblem } from '../../repo/watched-folders';
import type { ApiMethods } from '@shared/ipc';
import type { HandlerContext } from './context';

export function repoHandlers(ctx: HandlerContext) {
  const { gh, git, host, progress, repos, store, watchedFolders, withBusy } = ctx;
  return {
    // ---------------- repositories ----------------
    'repos.list': async () => repos.list(),
    'repos.add': async (path) => repos.add(path),
    'repos.remove': async (id, moveToTrash) => {
      // Trash first: if that fails, the repository stays registered instead of vanishing from the list with its folder left behind.
      const path = repos.get(id)?.path;
      if (path && moveToTrash && existsSync(path)) await host.trashItem(path);
      await repos.remove(id);
    },
    'repos.create': async (opts) => {
      const dir = resolve(opts.directory, opts.name);
      if (existsSync(dir) && (await readdir(dir)).length && (await ops.getTopLevel(git, dir))) throw new Error(`"${dir}" is already a Git repository.`);
      await mkdir(dir, { recursive: true });
      const configured = (await git.tryRun(null, ['config', '--global', '--get', 'init.defaultBranch']))?.stdout.trim();
      await ops.init(git, dir, configured || 'main');
      const created: string[] = [];
      if (opts.initializeWithReadme) {
        const readme = `# ${opts.name}\n${opts.description ? `\n${opts.description}\n` : ''}`;
        await writeFile(join(dir, 'README.md'), readme, 'utf8');
        created.push('README.md');
      }
      if (opts.gitignoreTemplate) {
        try {
          const source = await gh.gitignoreTemplate(opts.gitignoreTemplate);
          await writeFile(join(dir, '.gitignore'), source, 'utf8');
          created.push('.gitignore');
        } catch (err) {
          log.warn(`Could not fetch .gitignore template: ${(err as Error).message}`);
        }
      }
      if (opts.license) {
        try {
          let body = await gh.licenseText(opts.license);
          const identity = await ops.getConfigIdentity(git, null);
          body = body.replace(/\[year\]/g, String(new Date().getFullYear())).replace(/\[fullname\]/g, identity.global.name ?? '').replace(/\[yyyy\]/g, String(new Date().getFullYear())).replace(/\[name of copyright owner\]/g, identity.global.name ?? '');
          await writeFile(join(dir, 'LICENSE'), body, 'utf8');
          created.push('LICENSE');
        } catch (err) {
          log.warn(`Could not fetch license: ${(err as Error).message}`);
        }
      }
      if (created.length) {
        await stageFiles(git, dir, created);
        await git.run(dir, ['commit', '-q', '-m', 'Initial commit']);
      }
      return repos.add(dir);
    },
    'repos.clone': async (opts) => {
      let url = opts.url.trim();
      if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
      const target = resolve(opts.directory);
      const name = basename(target);
      if (existsSync(target) && (await readdir(target)).length) throw new Error(`The destination "${target}" already exists and is not empty.`);
      await mkdir(resolve(target, '..'), { recursive: true });
      const p = progress('clone', `Cloning ${name}`, null);
      try {
        await withBusy(`clone:${target}`, () => ops.clone(git, url, target, opts, (pct, desc) => p.update(pct, desc)));
      } finally {
        p.done();
      }
      return repos.add(target);
    },
    'repos.setAlias': async (id, alias) => repos.setAlias(id, alias),
    'repos.setAiDisabled': async (id, disabled) => repos.setAiDisabled(id, disabled),
    'repos.setPrefs': async (id, prefs) => repos.setPrefs(id, prefs),
    'repos.refreshIndicators': async () => repos.refreshIndicators(),

    // ---------------- watched folders ----------------
    'repos.scanWatchedFolders': async () => watchedFolders.scan(),
    'repos.cancelScan': async () => watchedFolders.cancel(),
    'repos.watchedFolders.add': async (path, depth) => {
      // Stored physically: git reports repositories by their resolved path, so
      // a folder kept as a symlink/junction path would never match what a scan
      // finds inside it (and nothing in it could be excluded on removal). The
      // path the user picked rides along for display, so Options names the
      // folder they chose rather than wherever it happens to point.
      const result = addWatchedFolder(store.getSettings().watchedFolders, await canonicalPath(path), depth, path);
      if (!result.ok) return { ok: false, error: result.error, settings: store.getSettings() };
      // The settings listener starts the scan; see WatchedFolderScanner.watchSettings.
      return { ok: true, settings: store.updateSettings({ watchedFolders: result.folders }) };
    },
    'repos.watchedFolders.status': async () => Promise.all(store.getSettings().watchedFolders.map(async (f) => ({ path: f.path, problem: await folderProblem(f.path) }))),
    'repos.isInWatchedFolder': async (repoPath) => repos.isInWatchedFolder(repoPath),
    'repos.exclusions.list': async () => store.getExcludedRepositoryPaths(),
    'repos.exclusions.remove': async (path) => {
      store.removeExcludedRepositoryPath(path);
      return store.getExcludedRepositoryPaths();
    },
    'repos.exclusions.clear': async () => {
      store.clearExcludedRepositoryPaths();
      return store.getExcludedRepositoryPaths();
    },
  } satisfies Partial<ApiMethods>;
}
