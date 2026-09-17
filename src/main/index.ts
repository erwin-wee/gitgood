import { join } from 'node:path';
import { app, BrowserWindow, Menu, nativeTheme } from 'electron';
import { ConflictResolver } from './ai/resolver';
import { GitClient } from './git/git';
import { fetch as gitFetch } from './git/operations';
import { GhClient } from './gh/gh';
import { registerIpc, sendEvent, type AppContext } from './ipc';
import { initLogger, log } from './logger';
import { buildMenu } from './menu';
import { RepositoryManager } from './repo/manager';
import { Store } from './store';
import { ToolLocator } from './tools';
import { createMainWindow } from './window';

app.setAppUserModelId('com.erwinwee.gitgood');
if (process.platform === 'win32') app.setName('GitGood');
// Test hook: isolate user data (settings, repository list) for automated runs.
if (process.env.GITGOOD_USER_DATA) app.setPath('userData', process.env.GITGOOD_USER_DATA);

/**
 * Parses GitHub's "Open with GitHub Desktop" links (x-github-client://openRepo/<url>?branch=..)
 * and our own gitgood:// equivalent.
 */
export function parseProtocolUrl(raw: string): { url: string; branch: string | null; filepath: string | null } | null {
  const m = /^(?:x-github-client|github-windows|github-mac|gitgood):\/\/openRepo\/(.+)$/i.exec(raw.trim());
  if (!m) return null;
  try {
    const target = new URL(m[1]);
    const branch = target.searchParams.get('branch');
    const filepath = target.searchParams.get('filepath');
    target.search = '';
    target.hash = '';
    return { url: target.toString().replace(/\/$/, ''), branch, filepath };
  } catch {
    return null;
  }
}

const PROTOCOLS = ['gitgood', 'x-github-client'];
const pendingProtocolUrls: string[] = [];

function protocolUrlFromArgv(argv: string[]): string | null {
  return argv.find((a) => /^(gitgood|x-github-client|github-windows|github-mac):\/\//i.test(a)) ?? null;
}

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
    sendEvent(win, 'menu.action', { action: 'protocol-open', args: parsed });
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

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    initLogger(join(userData, 'logs'));
    log.info(`GitGood ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform})`);

    const store = new Store(userData);
    store.load();
    nativeTheme.themeSource = store.getSettings().theme;

    const tools = new ToolLocator(store);
    const git = new GitClient(tools);
    const gh = new GhClient(tools);
    const repos = new RepositoryManager(store, git, (event, payload) => sendEvent(getWindow(), event, payload));
    const resolver = new ConflictResolver(store, tools, git);
    const ctx: AppContext = { store, tools, git, gh, repos, resolver, getWindow, busy: new Set() };
    registerIpc(ctx);
    Menu.setApplicationMenu(buildMenu(getWindow));

    if (app.isPackaged) {
      for (const proto of PROTOCOLS) {
        try {
          if (!app.isDefaultProtocolClient(proto)) app.setAsDefaultProtocolClient(proto);
        } catch (err) {
          log.warn(`Could not register ${proto}:// handler: ${(err as Error).message}`);
        }
      }
    }

    mainWindow = createMainWindow(store);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    mainWindow.webContents.once('did-finish-load', () => {
      // Give the renderer a moment to bootstrap before delivering queued links.
      setTimeout(() => {
        for (const raw of pendingProtocolUrls.splice(0)) deliverProtocolUrl(raw);
      }, 1500);
    });
    if (process.env.GITGOOD_SMOKE_SCRIPT) runSmokeScript(mainWindow, process.env.GITGOOD_SMOKE_SCRIPT);

    store.onSettingsChanged((settings) => sendEvent(getWindow(), 'settings.changed', settings));
    nativeTheme.on('updated', () => sendEvent(getWindow(), 'theme.changed', { dark: nativeTheme.shouldUseDarkColors }));

    // Discover git/gh/claude in the background and tell the renderer.
    void tools.refresh().then((state) => {
      log.info(`git: ${state.git.version ?? 'missing'} (${state.git.path ?? '-'}); gh: ${state.gh.version ?? 'missing'} (${state.gh.path ?? '-'}); account: ${state.ghAccount?.login ?? 'none'}`);
      sendEvent(getWindow(), 'tools.changed', state);
    });

    // Periodic background fetch for the active repository.
    setInterval(async () => {
      const minutes = store.getSettings().autoFetchIntervalMinutes;
      if (!minutes || minutes <= 0) return;
      const state = store.getState();
      const repo = state.currentRepositoryId ? repos.get(state.currentRepositoryId) : null;
      if (!repo || ctx.busy.has(repo.path)) return;
      const lastKey = `autofetch:${repo.path}`;
      const last = autoFetchTimes.get(lastKey) ?? 0;
      if (Date.now() - last < minutes * 60_000) return;
      autoFetchTimes.set(lastKey, Date.now());
      if (!tools.current().git.installed) return;
      try {
        ctx.busy.add(repo.path);
        await gitFetch(git, repo.path, 'origin', () => undefined);
        sendEvent(getWindow(), 'repo.changed', { repoPath: repo.path, reason: 'refs' });
      } catch (err) {
        log.warn(`Background fetch failed for ${repo.path}: ${(err as Error).message.split('\n')[0]}`);
      } finally {
        ctx.busy.delete(repo.path);
      }
    }, 30_000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(store);
    });
    app.on('before-quit', () => repos.dispose());
  });

  const autoFetchTimes = new Map<string, number>();

  /**
   * Automated smoke test: executes a JSON list of steps ({wait, js, shot})
   * against the renderer, saving screenshots, then quits.
   */
  function runSmokeScript(win: BrowserWindow, scriptJson: string): void {
    const steps = JSON.parse(scriptJson) as { wait?: number; js?: string; shot?: string; dump?: string }[];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    win.webContents.once('did-finish-load', async () => {
      try {
        for (const step of steps) {
          if (step.wait) await delay(step.wait);
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
            await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))', true).catch(() => undefined);
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
