import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { InboxItem } from '@shared/types';
import { ErrorExplainService } from './ai/error-explain';
import { ExplainService } from './ai/explain';
import { NlPaletteService } from './ai/nlPalette';
import { PrDraftService } from './ai/prDraft';
import { RebasePlanService } from './ai/rebasePlan';
import { ReleaseNotesService } from './ai/release-notes';
import { ConflictResolver } from './ai/resolver';
import { ReviewService } from './ai/review';
import { SplitterService } from './ai/splitter';
import { TriageService } from './ai/triage';
import { applyInboxBadge } from './badge';
import { clientServerUrl, registerClientIpc, showInboxNotification, watchServerVersion } from './client';
import { GitClient } from './git/git';
import { fetch as gitFetch } from './git/operations';
import { GhClient } from './gh/gh';
import { InboxPoller } from './gh/inbox-poller';
import { shouldNotifyInboxItem } from './gh/inbox';
import { SettingsSyncService } from './gh/settings-sync';
import { registerIpc, sendEvent, type HandlerDeps } from './ipc';
import { EventBus } from './core/bus';
import { ElectronHost } from './host/electron-host';
import { electronStorePlatform } from './host/electron-store-platform';
import { WatchedFolderScanner } from './repo/watched-folders';
import { initLogger, log } from './logger';
import { buildMenu } from './menu';
import { parseProtocolUrl, protocolUrlFromArgv } from './protocol';
import { RepositoryManager } from './repo/manager';
import { Store } from './store';
import { ToolLocator } from './tools';
import { ElectronUpdaterProvider, type ElectronAutoUpdater } from './update/electron-updater-provider';
import { isPerMachineInstall } from './update/update-core';
import { Updater, type DisabledEnv } from './update/updater';
import { createMainWindow } from './window';

const RELEASES_URL = 'https://github.com/erwin-wee/gitgood/releases';

/** Whether the running AppImage's own file can be rewritten in place (a prerequisite any AppImage self-updater needs); false (and irrelevant) when not running from an AppImage. */
function appImageWritable(appImagePath: string | undefined): boolean {
  if (!appImagePath) return false;
  try {
    accessSync(appImagePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

app.setAppUserModelId('com.erwinwee.gitgood');
if (process.platform === 'win32') app.setName('GitGood');
// Test hook: isolate user data (settings, repository list) for automated runs.
if (process.env.GITGOOD_USER_DATA) app.setPath('userData', process.env.GITGOOD_USER_DATA);

const PROTOCOLS = ['gitgood', 'x-github-client'];
const pendingProtocolUrls: string[] = [];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  const getWindow = () => mainWindow;

  const deliverProtocolUrl = (raw: string) => {
    const parsed = parseProtocolUrl(raw);
    if (!parsed) return;
    const win = getWindow();
    if (!win) {
      pendingProtocolUrls.push(raw);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    if (parsed.kind === 'review-rerun') sendEvent(win, 'menu.action', { action: 'protocol-review-rerun', args: { repoPath: parsed.repoPath } });
    else sendEvent(win, 'menu.action', { action: 'protocol-open', args: { url: parsed.url, branch: parsed.branch, filepath: parsed.filepath } });
  };

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = protocolUrlFromArgv(argv);
    if (url) deliverProtocolUrl(url);
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverProtocolUrl(url);
  });
  const initialUrl = protocolUrlFromArgv(process.argv);
  if (initialUrl) pendingProtocolUrls.push(initialUrl);

  /** Delivers protocol links that arrived before the renderer could take them. */
  const flushPendingProtocolUrls = (win: BrowserWindow) => {
    win.webContents.once('did-finish-load', () => {
      // Give the renderer a moment to bootstrap before delivering queued links.
      setTimeout(() => {
        for (const raw of pendingProtocolUrls.splice(0)) deliverProtocolUrl(raw);
      }, 1500);
    });
  };

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    initLogger(join(userData, 'logs'));
    log.info(`GitGood ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform})`);

    const store = new Store(userData, electronStorePlatform);
    store.load();

    let serverUrl: string | null;
    try {
      serverUrl = clientServerUrl(userData);
    } catch (err) {
      dialog.showErrorBox('GitGood', `Invalid server URL (GITGOOD_SERVER_URL or ${join(userData, 'server-url')}): ${(err as Error).message}`);
      app.quit();
      return;
    }
    if (serverUrl) {
      // Client mode: settings, repositories and every service live on the server; this store only keeps window bounds and zoom.
      log.info(`Client mode: using the GitGood server at ${serverUrl}`);
      registerClientIpc(serverUrl, store, getWindow);
      Menu.setApplicationMenu(buildMenu(getWindow));
      const openWindow = () => {
        mainWindow = createMainWindow(store, undefined, serverUrl);
        watchServerVersion(serverUrl, mainWindow, app.getVersion());
        mainWindow.on('closed', () => {
          mainWindow = null;
        });
        flushPendingProtocolUrls(mainWindow);
      };
      openWindow();
      if (process.env.GITGOOD_SMOKE_SCRIPT && mainWindow) runSmokeScript(mainWindow, process.env.GITGOOD_SMOKE_SCRIPT);
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openWindow();
      });
      return;
    }

    nativeTheme.themeSource = store.getSettings().theme;
    const bus = new EventBus();
    const host = new ElectronHost(getWindow);
    const busy = new Set<string>();
    bus.subscribe((event, payload) => sendEvent(getWindow(), event, payload));

    const tools = new ToolLocator(store);
    const git = new GitClient(tools);
    const gh = new GhClient(tools);
    const repos = new RepositoryManager(store, git, bus.emit);
    const resolver = new ConflictResolver(store, tools, git);
    const review = new ReviewService(store, tools, git, gh, repos, userData);
    const splitter = new SplitterService(store, tools, git);
    const triage = new TriageService(store, tools, gh, repos, userData);
    const prDraft = new PrDraftService(store, tools, git, gh, repos);
    const rebasePlan = new RebasePlanService(store, tools, git);
    const releaseNotes = new ReleaseNotesService(store, tools, git, gh, repos);
    const explain = new ExplainService(store, tools, git);
    const errorExplain = new ErrorExplainService(store, tools, git);
    const nlPalette = new NlPaletteService(store, tools, git);
    const inbox = new InboxPoller(
      store,
      gh,
      (state) => {
        bus.emit('gh.inbox.changed', state);
        applyInboxBadge(getWindow(), state.unreadCount);
      },
      (items) => notifyNewInboxItems(items),
      { listLocalRepos: () => store.getRepositories().map((r) => ({ id: r.id, github: r.github })), getAccount: () => tools.current().ghAccount },
    );
    const settingsSync = new SettingsSyncService(store, gh, repos);
    const watchedFolders = new WatchedFolderScanner(store, repos, bus.emit);
    const disabledEnv: DisabledEnv = { isPackaged: app.isPackaged, platform: process.platform, portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR, appImagePath: process.env.APPIMAGE, appImageWritable: appImageWritable(process.env.APPIMAGE) };
    // electron-updater's AppUpdater is a TypedEmitter generic over its own event map, which does not
    // structurally satisfy ElectronAutoUpdater's plain string-keyed on/once/off — verified by hand
    // against electron-updater's .d.ts (AppUpdater.d.ts, types.d.ts) that the real singleton has every
    // member this provider actually calls.
    const updateProvider = new ElectronUpdaterProvider(autoUpdater as unknown as ElectronAutoUpdater, () => store.getSettings().updateChannel);
    const updater = new Updater(store, updateProvider, (state) => {
      log.info(`Update state: ${state.status}${state.status === 'available' ? ` (${state.version})` : ''}`);
      bus.emit('app.update.changed', state);
    }, { getVersion: () => app.getVersion(), manualUrl: RELEASES_URL, disabledEnv, isPerMachineInstall: isPerMachineInstall(process.execPath, process.platform) });
    const deps: HandlerDeps = { store, tools, git, gh, repos, resolver, review, splitter, triage, prDraft, rebasePlan, releaseNotes, explain, errorExplain, inbox, settingsSync, updater, nlPalette, watchedFolders, host, emit: bus.emit, busy };
    registerIpc(deps);
    Menu.setApplicationMenu(buildMenu(getWindow));

    /** Desktop notification for a freshly-arrived inbox item (only while the window is unfocused; see shouldNotifyInboxItem for the per-category gating). */
    function notifyNewInboxItems(items: InboxItem[]): void {
      // Smoke runs are offscreen and never focused; never pop OS notifications on the developer's desktop from them.
      if (process.env.GITGOOD_SMOKE_SCRIPT || inbox.isFocused() || !Notification.isSupported()) return;
      const settings = store.getSettings();
      for (const item of items) {
        if (shouldNotifyInboxItem(item, settings)) showInboxNotification(getWindow, item);
      }
    }

    if (app.isPackaged) {
      for (const proto of PROTOCOLS) {
        try {
          if (!app.isDefaultProtocolClient(proto)) app.setAsDefaultProtocolClient(proto);
        } catch (err) {
          log.warn(`Could not register ${proto}:// handler: ${(err as Error).message}`);
        }
      }
    }

    // Shared so the `activate` re-create below wires focus tracking too; without
    // it a window recreated after every window was closed stops driving the
    // inbox poller's focus/blur cadence.
    const onFocusChange = (focused: boolean) => (focused ? inbox.onFocus() : inbox.onBlur());
    mainWindow = createMainWindow(store, onFocusChange);
    applyInboxBadge(mainWindow, inbox.getState().unreadCount);
    inbox.start();
    updater.start();
    watchedFolders.watchSettings();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    flushPendingProtocolUrls(mainWindow);
    if (process.env.GITGOOD_SMOKE_SCRIPT) runSmokeScript(mainWindow, process.env.GITGOOD_SMOKE_SCRIPT);

    store.onSettingsChanged((settings) => bus.emit('settings.changed', settings));
    nativeTheme.on('updated', () => bus.emit('theme.changed', { dark: nativeTheme.shouldUseDarkColors }));

    // Discover git/gh/claude in the background and tell the renderer.
    void tools.refresh().then((state) => {
      log.info(`git: ${state.git.version ?? 'missing'} (${state.git.path ?? '-'}); gh: ${state.gh.version ?? 'missing'} (${state.gh.path ?? '-'}); account: ${state.ghAccount?.login ?? 'none'}`);
      bus.emit('tools.changed', state);
      // A scan registers candidates through Git, so wait until initial tool discovery finishes.
      if (store.getSettings().watchedFolders.length) {
        log.info('Scanning watched folders');
        void watchedFolders
          .scan()
          .then((r) => log.info(`Watched-folder scan: ${r.added} added, ${r.skipped} skipped, ${r.dropped} dropped, ${r.unreadable} unreadable${r.cancelled ? ', cancelled' : ''}`))
          .catch((err) => log.error('Watched-folder scan failed', err));
      }
    });

    // Periodic background fetch for the active repository.
    setInterval(async () => {
      const minutes = store.getSettings().autoFetchIntervalMinutes;
      if (!minutes || minutes <= 0) return;
      const state = store.getState();
      const repo = state.currentRepositoryId ? repos.get(state.currentRepositoryId) : null;
      if (!repo || busy.has(repo.path)) return;
      const lastKey = `autofetch:${repo.path}`;
      const last = autoFetchTimes.get(lastKey) ?? 0;
      if (Date.now() - last < minutes * 60_000) return;
      autoFetchTimes.set(lastKey, Date.now());
      if (!tools.current().git.installed) return;
      try {
        busy.add(repo.path);
        await gitFetch(git, repo.path, 'origin', () => undefined);
        bus.emit('repo.changed', { repoPath: repo.path, reason: 'refs' });
      } catch (err) {
        log.warn(`Background fetch failed for ${repo.path}: ${(err as Error).message.split('\n')[0]}`);
      } finally {
        busy.delete(repo.path);
      }
    }, 30_000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(store, onFocusChange);
    });
    app.on('before-quit', () => {
      inbox.dispose();
      updater.dispose();
      repos.dispose();
    });
  });

  const autoFetchTimes = new Map<string, number>();

  /**
   * Automated smoke test: executes a JSON list of steps ({wait, js, shot})
   * against the renderer, saving screenshots, then quits.
   */
  function runSmokeScript(win: BrowserWindow, scriptJson: string): void {
    const steps = JSON.parse(scriptJson) as { wait?: number; js?: string; shot?: string; dump?: string; rm?: string }[];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    win.webContents.once('did-finish-load', async () => {
      try {
        for (const step of steps) {
          if (step.wait) await delay(step.wait);
          // `rm` deletes a path between steps, for scenarios that have to
          // simulate a repository disappearing from disk (watched folders).
          if (step.rm) {
            const { rm } = await import('node:fs/promises');
            await rm(step.rm, { recursive: true, force: true });
            log.info(`smoke removed path: ${step.rm}`);
          }
          if (step.js) {
            try {
              const result = await win.webContents.executeJavaScript(step.js, true);
              if (step.dump) {
                const { writeFile } = await import('node:fs/promises');
                await writeFile(step.dump, typeof result === 'string' ? result : JSON.stringify(result, null, 2));
              }
            } catch (err) {
              log.error(`smoke js failed: ${step.js}`, err);
            }
          }
          if (step.shot) {
            // Occluded windows never fire requestAnimationFrame, so do not wait forever for a paint.
            await Promise.race([win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))', true).catch(() => undefined), delay(1500)]);
            win.webContents.invalidate();
            await delay(350);
            const image = await win.webContents.capturePage();
            const { writeFile } = await import('node:fs/promises');
            await writeFile(step.shot, image.toPNG());
            log.info(`smoke screenshot written: ${step.shot}`);
          }
        }
      } finally {
        app.quit();
      }
    });
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  process.on('uncaughtException', (err) => log.error('Uncaught exception', err));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));
}
