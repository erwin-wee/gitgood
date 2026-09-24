import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, dialog } from 'electron';

const execFileAsync = promisify(execFile);
const UNIT_NAME = 'gitgood-server';
const UNIT_MARKER = '# Managed by the GitGood desktop app; rewritten on launch.';
const SERVER_URL = 'http://127.0.0.1:4600';

export interface UnitStatus {
  exists: boolean;
  managed: boolean;
  text: string | null;
}

/**
 * The service starts the bundled server through Electron's Node mode. The
 * trailing `-- --no-sandbox` stops the AppImage's AppRun from prepending
 * `--no-sandbox` (which Node mode rejects) on systems without user
 * namespaces; after `--` Node treats it as a plain script argument.
 */
export function managedUnit(exe: string): string {
  const entry = "import(require('node:url').pathToFileURL(require('node:path').join(process.resourcesPath,'app.asar','out','server','index.mjs')).href)";
  // systemd splits unquoted words and expands % specifiers.
  const quotedExe = `"${exe.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  return `[Unit]
Description=GitGood headless server
After=network.target
${UNIT_MARKER}

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=${quotedExe} -e "${entry}" -- --no-sandbox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${UNIT_NAME}.service`);
}

function currentExecutable(): string {
  return process.env.APPIMAGE || process.execPath;
}

function supported(): boolean {
  return process.platform === 'linux' && app.isPackaged;
}

export function readUnit(): UnitStatus {
  const file = unitPath();
  if (!existsSync(file)) return { exists: false, managed: false, text: null };
  try {
    const text = readFileSync(file, 'utf8');
    return { exists: true, managed: text.includes(UNIT_MARKER), text };
  } catch {
    return { exists: true, managed: false, text: null };
  }
}

async function systemctl(...args: string[]): Promise<void> {
  await execFileAsync('systemctl', ['--user', ...args]);
}

/** Rewrites only units previously installed by this desktop, then restarts a skewed server. */
export async function ensureManagedServer(serverVersion: string | null, desktopVersion: string): Promise<'unmanaged' | 'ok' | 'restarted'> {
  if (!supported()) return 'ok';
  const unit = readUnit();
  if (!unit.managed) return 'unmanaged';

  const expected = managedUnit(currentExecutable());
  const changed = unit.text !== expected;
  if (changed) {
    const file = unitPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, expected);
    await systemctl('daemon-reload');
  }
  if (changed || serverVersion !== desktopVersion) {
    await systemctl('restart', UNIT_NAME);
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
  if (!supported()) return;
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
        message: 'An unmanaged gitgood-server.service already exists.',
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

    const file = unitPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, managedUnit(currentExecutable()));
    await systemctl('daemon-reload');
    await systemctl('enable', '--now', UNIT_NAME);
    await systemctl('restart', UNIT_NAME);

    writeFileSync(join(userData, 'server-url'), `${SERVER_URL}\n`);
    app.relaunch();
    app.exit(0);
  } catch (err) {
    dialog.showErrorBox('GitGood server', err instanceof Error ? err.message : String(err));
  }
}

