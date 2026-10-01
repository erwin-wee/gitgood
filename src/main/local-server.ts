import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { app, dialog } from 'electron';

const execFileAsync = promisify(execFile);
const UNIT_NAME = 'gitgood-server';
const LAUNCHD_LABEL = 'com.gitgood.server';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'GitGoodServer';
/** Makes the packaged exe run only the headless server (see `startBackgroundServer`); the Windows login item passes it. */
export const BACKGROUND_SERVER_FLAG = '--gitgood-server';
/** Present in every definition the desktop installs (as a comment), so only its own service definitions are ever rewritten. */
const MARKER = 'Managed by the GitGood desktop app; rewritten on launch.';
const SERVER_URL = 'http://127.0.0.1:4600';
/** Runs the bundled server under Electron's Node mode (`ELECTRON_RUN_AS_NODE=1`). */
const NODE_ENTRY = "import(require('node:url').pathToFileURL(require('node:path').join(process.resourcesPath,'app.asar','out','server','index.mjs')).href)";

export interface UnitStatus {
  exists: boolean;
  managed: boolean;
  text: string | null;
}

/**
 * The systemd unit. The trailing `-- --no-sandbox` stops the AppImage's AppRun
 * from prepending `--no-sandbox` (which Node mode rejects) on systems without
 * user namespaces; after `--` Node treats it as a plain script argument.
 */
export function managedUnit(exe: string): string {
  // systemd splits unquoted words and expands % specifiers.
  const quotedExe = `"${exe.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  return `[Unit]
Description=GitGood headless server
After=network.target
# ${MARKER}

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=${quotedExe} -e "${NODE_ENTRY}" -- --no-sandbox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** The macOS LaunchAgent: starts at login and is restarted when the server exits with an error. */
export function managedPlist(exe: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MARKER} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(exe)}</string>
    <string>-e</string>
    <string>${esc(NODE_ENTRY)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

/** The Windows login item (HKCU Run value): the GUI exe started with the flag that makes it run only the server. */
export function managedRunCommand(exe: string): string {
  return `"${exe}" ${BACKGROUND_SERVER_FLAG}`;
}

/** The value data from `reg query KEY /v NAME` output, or null when absent. */
export function parseRegQuery(stdout: string): string | null {
  const m = new RegExp(`^\\s*${RUN_VALUE}\\s+REG_SZ\\s+(.*?)\\s*$`, 'm').exec(stdout);
  return m ? m[1] : null;
}

/** Escapes a PowerShell single-quoted string. */
function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** One OS command of a service lifecycle; `optional` steps (e.g. stopping a service that may not run) may fail. */
interface Step {
  argv: string[];
  optional?: boolean;
}

interface ServiceBackend {
  /** The definition file the desktop owns (systemd unit, LaunchAgent plist); null where the definition is a registry value. */
  file: string | null;
  /** Reads the definition when it is not a file (Windows `reg query`). */
  query?: Step;
  render(exe: string): string;
  /** Runs after the definition is written: start now and at every login. */
  install(exe: string): Step[];
  /** Runs when the server must be restarted; `rewritten` when the definition just changed. */
  restart(rewritten: boolean, exe: string): Step[];
}

/** The service manager of `platform`: systemd user unit, launchd LaunchAgent, or (Windows) a per-user Run-key login item. */
export function serviceBackend(platform: NodeJS.Platform, o: { home: string; uid?: number; xdgConfigHome?: string }): ServiceBackend | null {
  if (platform === 'linux') {
    const systemctl = (...args: string[]): Step => ({ argv: ['systemctl', '--user', ...args] });
    return {
      file: posix.join(o.xdgConfigHome || posix.join(o.home, '.config'), 'systemd', 'user', `${UNIT_NAME}.service`),
      render: managedUnit,
      install: () => [systemctl('daemon-reload'), systemctl('enable', '--now', UNIT_NAME), systemctl('restart', UNIT_NAME)],
      restart: (rewritten) => (rewritten ? [systemctl('daemon-reload'), systemctl('restart', UNIT_NAME)] : [systemctl('restart', UNIT_NAME)]),
    };
  }
  if (platform === 'darwin') {
    const domain = `gui/${o.uid}`;
    const target = `${domain}/${LAUNCHD_LABEL}`;
    const file = posix.join(o.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const bootout: Step = { argv: ['launchctl', 'bootout', target], optional: true };
    const bootstrap: Step = { argv: ['launchctl', 'bootstrap', domain, file] };
    const kickstart: Step = { argv: ['launchctl', 'kickstart', '-k', target] };
    // A changed plist only takes effect after it is booted out and in again; an unchanged, already loaded agent just restarts.
    const reload = [bootout, bootstrap, kickstart];
    return { file, render: managedPlist, install: () => reload, restart: (rewritten) => (rewritten ? reload : [{ ...bootstrap, optional: true }, kickstart]) };
  }
  if (platform === 'win32') {
    // A per-user Run entry needs no elevation and launches the GUI-subsystem exe (no console window); the exe then runs the server itself (startBackgroundServer).
    const ps = (script: string): Step => ({ argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], optional: true });
    const stop = (exe: string) => ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${psQuote(win32.basename(exe))}' -and $_.CommandLine -like '*${BACKGROUND_SERVER_FLAG}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
    const start = (exe: string): Step => ({ argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${psQuote(exe)}' -ArgumentList '${BACKGROUND_SERVER_FLAG}'`] });
    const register = (exe: string): Step => ({ argv: ['reg', 'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', managedRunCommand(exe), '/f'] });
    return {
      file: null,
      query: { argv: ['reg', 'query', RUN_KEY, '/v', RUN_VALUE] },
      render: managedRunCommand,
      install: (exe) => [register(exe), stop(exe), start(exe)],
      restart: (rewritten, exe) => [...(rewritten ? [register(exe)] : []), stop(exe), start(exe)],
    };
  }
  return null;
}

function backend(): ServiceBackend | null {
  return app.isPackaged ? serviceBackend(process.platform, { home: homedir(), uid: process.getuid?.(), xdgConfigHome: process.env.XDG_CONFIG_HOME }) : null;
}

function currentExecutable(): string {
  return process.env.APPIMAGE || process.execPath;
}

/** Whether this build can install the background server on this OS (packaged desktop on Linux, macOS or Windows). */
export function managedServerSupported(): boolean {
  return backend() !== null;
}

export function readUnit(): UnitStatus {
  const service = backend();
  if (!service) return { exists: false, managed: false, text: null };
  try {
    // Windows keeps the definition in the registry (sync: callers decide the banner action inline).
    const text = service.query ? parseRegQuery(execFileSync(service.query.argv[0], service.query.argv.slice(1), { encoding: 'utf8', windowsHide: true })) : service.file && existsSync(service.file) ? readFileSync(service.file, 'utf8') : null;
    return text === null ? { exists: false, managed: false, text: null } : { exists: true, managed: text.includes(MARKER) || text.endsWith(` ${BACKGROUND_SERVER_FLAG}`), text };
  } catch {
    // `reg query` exits non-zero when the value is absent; an unreadable file is treated as foreign.
    return service.query ? { exists: false, managed: false, text: null } : { exists: true, managed: false, text: null };
  }
}

/** Writes the definition file; Windows has none (its install/restart steps write the registry value). */
function writeDefinition(service: ServiceBackend, text: string): void {
  if (!service.file) return;
  mkdirSync(dirname(service.file), { recursive: true });
  writeFileSync(service.file, text);
}

/** Entry for `GitGood.exe --gitgood-server` (Windows login item): runs the bundled headless server inside this Electron process, with no window, menu or single-instance lock. */
export function startBackgroundServer(): void {
  app.dock?.hide();
  const entry = pathToFileURL(join(process.resourcesPath, 'app.asar', 'out', 'server', 'index.mjs')).href;
  import(/* @vite-ignore */ entry).catch((err: unknown) => {
    console.error('GitGood server failed to start', err);
    app.exit(1);
  });
}

async function runSteps(steps: Step[]): Promise<void> {
  for (const { argv, optional } of steps) {
    try {
      await execFileAsync(argv[0], argv.slice(1), { windowsHide: true });
    } catch (err) {
      if (!optional) throw err;
    }
  }
}

/** Rewrites only definitions previously installed by this desktop, then restarts a skewed server. */
export async function ensureManagedServer(serverVersion: string | null, desktopVersion: string): Promise<'unmanaged' | 'ok' | 'restarted'> {
  const service = backend();
  if (!service) return 'ok';
  const unit = readUnit();
  if (!unit.managed) return 'unmanaged';

  const exe = currentExecutable();
  const expected = service.render(exe);
  const changed = unit.text !== expected;
  if (changed) writeDefinition(service, expected);
  if (changed || serverVersion !== desktopVersion) {
    await runSteps(service.restart(changed, exe));
    return 'restarted';
  }
  return 'ok';
}

function copyInitialData(userData: string, serverData: string): void {
  const settings = join(serverData, 'settings.json');
  if (existsSync(settings)) return;
  for (const name of ['settings.json', 'repositories.json', 'state.json']) {
    const source = join(userData, name);
    const target = join(serverData, name);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
  }
}

/** Installs the desktop-managed service and switches this launch to client mode. */
export async function setUpManagedServer(userData: string): Promise<void> {
  const service = backend();
  if (!service) return;
  try {
    const confirmation = await dialog.showMessageBox({
      type: 'info',
      title: 'Run GitGood server in the background',
      message: 'Run GitGood server in the background?',
      detail: 'This installs a background service that keeps GitGood reachable at http://127.0.0.1:4600 and over tailscale serve. GitGood will use it and update it automatically.',
      buttons: ['Cancel', 'Install'],
      defaultId: 1,
      cancelId: 0,
    });
    if (confirmation.response !== 1) return;

    const existing = readUnit();
    if (existing.exists && !existing.managed) {
      const replace = await dialog.showMessageBox({
        type: 'warning',
        title: 'Replace GitGood server service?',
        message: `An unmanaged ${service.file ? basename(service.file) : RUN_VALUE} already exists.`,
        detail: 'It may be running from a source checkout. Replace it with the desktop-managed service?',
        buttons: ['Cancel', 'Replace'],
        defaultId: 1,
        cancelId: 0,
      });
      if (replace.response !== 1) return;
    }

    const serverData = join(homedir(), '.config', 'gitgood-server');
    mkdirSync(serverData, { recursive: true });
    copyInitialData(userData, serverData);

    writeDefinition(service, service.render(currentExecutable()));
    await runSteps(service.install(currentExecutable()));

    writeFileSync(join(userData, 'server-url'), `${SERVER_URL}\n`);
    app.relaunch();
    app.exit(0);
  } catch (err) {
    dialog.showErrorBox('GitGood server', err instanceof Error ? err.message : String(err));
  }
}
