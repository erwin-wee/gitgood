#!/usr/bin/env node
// Installs and starts a systemd user service running this checkout's server
// build (`npm run build` first). Re-run after moving the checkout or switching Node.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'out', 'server', 'index.mjs');
if (!existsSync(entry)) {
  console.error(`${entry} not found. Run "npm run build" first.`);
  process.exit(1);
}

const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
const unitFile = join(unitDir, 'gitgood-server.service');
mkdirSync(unitDir, { recursive: true });
writeFileSync(
  unitFile,
  `[Unit]
Description=GitGood headless server
After=network.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${process.execPath} ${entry}
Restart=on-failure
RestartSec=2
# Settings (GITGOOD_SERVER_PORT, GITGOOD_ALLOWED_LOGIN, ...): systemctl --user edit gitgood-server

[Install]
WantedBy=default.target
`,
);
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'gitgood-server'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', 'gitgood-server'], { stdio: 'inherit' });
console.log(`Installed ${unitFile}; logs: journalctl --user -u gitgood-server -f`);
