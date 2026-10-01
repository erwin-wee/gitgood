import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { difftoolArgs, launchGitTool } from '../../git/external-tools';
import { toFsPath } from '../../git/diff';
import * as ops from '../../git/operations';
import { findEditors, openInEditor } from '../../integrations/editors';
import { findShells, openShell } from '../../integrations/shells';
import { getLogPath, log } from '../../logger';
import { canonicalPath } from '../../repo/paths';
import { sanitizeWatchedFolders } from '../../repo/watched-folders';
import { canInstall } from '../../update/update-core';
import type { ApiMethods } from '@shared/ipc';
import { operationControllers, type HandlerContext } from './context';

export function appHandlers(ctx: HandlerContext) {
  const { errorExplain, explain, freshStatus, git, host, nlPalette, prDraft, rebasePlan, releaseNotes, repos, resolver, review, send, settingsSync, splitter, store, tools, triage, updater } = ctx;
  return {
    // ---------------- app ----------------
    'app.info': async () => ({ version: host.appVersion(), electron: process.versions.electron ?? '', platform: process.platform, userDataPath: host.userDataPath(), logPath: getLogPath() }),
    // Without awaiting the git probe, the first call would answer with the pre-scan state and the renderer
    // would flash the "GitGood needs Git to run" setup screen. The other probes (gh, claude, gpg, …) are
    // not awaited: they flag `pending` and arrive later as `tools.changed`.
    'app.tools': async (refresh) => {
      if (refresh) return tools.refresh();
      await tools.ensure('git');
      return tools.current();
    },
    'app.settings.get': async () => store.getSettings(),
    'app.settings.set': async (patch) => {
      const before = store.getSettings();
      // Depth clamping, canonical paths and the no-duplicate/no-nesting rules
      // hold whichever route the list arrives by, not only
      // repos.watchedFolders.add — otherwise the two disagree about whether a
      // symlink and its target are the same folder, and it gets walked twice.
      if (patch.watchedFolders) {
        // Dropped before the map rather than inside sanitizeWatchedFolders,
        // because reading `f.path` off a malformed entry (a hand-edited
        // settings.json) would throw out of the whole settings save.
        const entries = (Array.isArray(patch.watchedFolders) ? patch.watchedFolders : []).filter((f) => f && typeof f.path === 'string');
        // A folder edited here keeps the display path it was registered with;
        // one arriving without it (a hand-edited settings.json, an older file)
        // is displayed by the path as written, which is what its author typed.
        const canonical = await Promise.all(entries.map(async (f) => ({ ...f, path: await canonicalPath(f.path), displayPath: f.displayPath ?? f.path })));
        patch = { ...patch, watchedFolders: sanitizeWatchedFolders(canonical) };
      }
      const next = store.updateSettings(patch);
      if (patch.gitPath !== undefined || patch.ghPath !== undefined || patch.ai?.claudeCliPath !== undefined) {
        void tools.refresh();
      }
      if (patch.theme && patch.theme !== before.theme) {
        host.setTheme(patch.theme);
      }
      return next;
    },
    'app.setApiKey': async (key) => {
      store.setApiKey(key && key.trim() ? key.trim() : null);
      return store.getSettings().ai;
    },
    'app.setOpenaiApiKey': async (key) => {
      store.setOpenaiApiKey(key && key.trim() ? key.trim() : null);
      return store.getSettings().ai;
    },
    'app.openExternal': async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      await host.openExternal(url);
    },
    'app.showItemInFolder': async (p) => host.showItemInFolder(p),
    'app.openPath': async (p) => host.openPath(p),
    'app.chooseDirectory': async (opts) => host.chooseDirectory(opts),
    'app.chooseFile': async (opts) => host.chooseFile(opts),
    'app.chooseSavePath': async (opts) => host.chooseSavePath(opts),
    'app.editors': async () => findEditors((await tools.env()).PATH),
    'app.shells': async () => findShells((await tools.env()).PATH),
    'app.openInEditor': async (repoPath, filePath) => {
      const settings = store.getSettings();
      const editors = await findEditors((await tools.env()).PATH);
      const editorPath = settings.externalEditor === 'custom' ? settings.customEditorPath : (editors.find((e) => e.id === settings.externalEditor) ?? editors[0])?.path;
      if (!editorPath) throw new Error('No external editor was found. Configure one in Options → Integrations.');
      const target = filePath ? toFsPath(repoPath, filePath) : repoPath;
      await openInEditor(editorPath, target);
    },
    'app.openInShell': async (repoPath) => {
      const settings = store.getSettings();
      await openShell(settings.shell, settings.shell === 'custom' ? settings.customShellPath : null, repoPath, (await tools.env()).PATH);
    },
    'app.openDiffTool': async (repoPath, path, source) => {
      toFsPath(repoPath, path);
      await launchGitTool(git, repoPath, 'diff', difftoolArgs(path, source), () => {});
    },
    'app.openMergeTool': async (repoPath, path) => {
      toFsPath(repoPath, path);
      await launchGitTool(git, repoPath, 'merge', ['mergetool', '--no-prompt', '--', path], () => send('repo.changed', { repoPath, reason: 'both' }));
    },
    'app.clipboard.write': async (text) => host.clipboardWrite(text),
    'app.pathExists': async (p) => existsSync(p),
    'app.isRepository': async (p) => (await ops.getTopLevel(git, p)) !== null,
    'app.joinPath': async (...parts) => join(...parts),
    'app.log': async (level, message) => log[level](`[renderer] ${message}`),
    'app.newWindow': async (repoId) => host.openWindow(repoId),
    'app.setShortcuts': async (overrides) => host.setMenuShortcuts(overrides),
    'app.zoom': async (direction) => {
      const next = host.zoom(direction);
      store.updateState({ zoomLevel: next });
      return next;
    },
    'app.notify': async (title, body) => {
      if (process.env.GITGOOD_SMOKE_SCRIPT) return; // offscreen smoke runs must not raise desktop notifications
      await host.notify(title, body);
    },
    'app.moveToTrash': async (p) => host.trashItem(p),
    'app.operations.cancel': async (id) => {
      operationControllers.get(id)?.abort();
    },

    // ---------------- auto-update ----------------
    'app.update.state': async () => updater.getState(),
    'app.update.check': async () => updater.checkNow(true),
    'app.update.download': async () => {
      if (updater.canAutoUpdate) {
        await updater.startDownload();
        return;
      }
      const state = updater.getState();
      if (state.status === 'available') await host.openExternal(state.url);
    },
    'app.update.install': async () => {
      const currentId = store.getState().currentRepositoryId;
      const repo = currentId ? repos.get(currentId) : null;
      const operationKind = repo ? (await freshStatus(repo.path)).operation.kind : 'none';
      const gate = canInstall({ operationKind, aiActive: resolver.isActive() || review.isActive() || triage.isActive() || prDraft.isActive() || releaseNotes.isActive() || explain.isActive() || errorExplain.isActive() || splitter.isActive() || rebasePlan.isActive() || nlPalette.isActive() });
      if (!gate.ok) throw new Error(gate.reason);
      // Reopen the same repository after the relaunch an install causes.
      if (repo) store.updateState({ currentRepositoryId: repo.id });
      await updater.quitAndInstall();
    },
    'app.update.dismiss': async (version) => updater.dismiss(version),

    // ---------------- settings export / import / gist sync ----------------
    'settings.export': async (sections) => store.buildExport(sections, await repos.list(false)),
    'settings.exportToFile': async (path, sections) => {
      const data = store.buildExport(sections, await repos.list(false));
      await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
    },
    'settings.previewImport': async (path, mode) => {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      return store.previewImport(raw, await repos.list(false), mode);
    },
    'settings.import': async (path, mode, sections) => {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      const settings = store.importSettings(raw, mode, sections);
      if (sections.includes('repositories')) send('repos.changed', await repos.list());
      return settings;
    },
    'settings.sync.status': async () => settingsSync.status(),
    'settings.sync.enable': async () => settingsSync.enable(),
    'settings.sync.disable': async (deleteGist) => settingsSync.disable(deleteGist),
    'settings.sync.upload': async () => settingsSync.upload(),
    'settings.sync.download': async (mode) => {
      const settings = await settingsSync.download(mode);
      send('repos.changed', await repos.list());
      return settings;
    },
  } satisfies Partial<ApiMethods>;
}
