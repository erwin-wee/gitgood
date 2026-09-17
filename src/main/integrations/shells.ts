import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FoundShell } from '@shared/types';
import { cmdQuote, launchDetached, startOnWindows } from '../exec';
import { findExecutable } from '../tools';

const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
const local = process.env.LOCALAPPDATA ?? '';

interface ShellCandidate {
  id: string;
  name: string;
  find: (pathEnv: string | undefined) => Promise<string | null>;
  launch: (path: string, cwd: string) => Promise<void>;
}

const WINDOWS: ShellCandidate[] = [
  {
    id: 'wt',
    name: 'Windows Terminal',
    find: async (p) => (await findExecutable('wt', [join(local, 'Microsoft', 'WindowsApps')], p)) ?? null,
    launch: (path, cwd) => launchDetached(path, ['-d', cwd]),
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    find: async (p) => (await findExecutable('pwsh', [join(pf, 'PowerShell', '7')], p)) ?? (await findExecutable('powershell', [], p)) ?? null,
    launch: (path, cwd) => startOnWindows([cmdQuote(path), '-NoExit'], cwd),
  },
  {
    id: 'cmd',
    name: 'Command Prompt',
    find: async () => (process.env.ComSpec && existsSync(process.env.ComSpec) ? process.env.ComSpec : 'C:\\Windows\\System32\\cmd.exe'),
    launch: (path, cwd) => startOnWindows([cmdQuote(path)], cwd),
  },
  {
    id: 'gitbash',
    name: 'Git Bash',
    find: async () => {
      for (const c of [join(pf, 'Git', 'git-bash.exe'), join(process.env['ProgramFiles(x86)'] ?? '', 'Git', 'git-bash.exe'), join(local, 'Programs', 'Git', 'git-bash.exe')]) if (c && existsSync(c)) return c;
      return null;
    },
    launch: (path, cwd) => launchDetached(path, [`--cd=${cwd}`], { cwd }),
  },
];

const MAC: ShellCandidate[] = [
  { id: 'terminal', name: 'Terminal', find: async () => '/System/Applications/Utilities/Terminal.app', launch: (_p, cwd) => launchDetached('open', ['-a', 'Terminal', cwd]) },
  { id: 'iterm', name: 'iTerm2', find: async () => (existsSync('/Applications/iTerm.app') ? '/Applications/iTerm.app' : null), launch: (_p, cwd) => launchDetached('open', ['-a', 'iTerm', cwd]) },
  { id: 'warp', name: 'Warp', find: async () => (existsSync('/Applications/Warp.app') ? '/Applications/Warp.app' : null), launch: (_p, cwd) => launchDetached('open', ['-a', 'Warp', cwd]) },
  { id: 'ghostty', name: 'Ghostty', find: async () => (existsSync('/Applications/Ghostty.app') ? '/Applications/Ghostty.app' : null), launch: (_p, cwd) => launchDetached('open', ['-a', 'Ghostty', cwd]) },
];

const LINUX: ShellCandidate[] = [
  { id: 'ghostty', name: 'Ghostty', find: (p) => findExecutable('ghostty', [], p), launch: (path, cwd) => launchDetached(path, [`--working-directory=${cwd}`]) },
  { id: 'alacritty', name: 'Alacritty', find: (p) => findExecutable('alacritty', [], p), launch: (path, cwd) => launchDetached(path, ['--working-directory', cwd]) },
  { id: 'kitty', name: 'kitty', find: (p) => findExecutable('kitty', [], p), launch: (path, cwd) => launchDetached(path, ['--directory', cwd]) },
  { id: 'foot', name: 'foot', find: (p) => findExecutable('foot', [], p), launch: (path, cwd) => launchDetached(path, ['-D', cwd]) },
  { id: 'wezterm', name: 'WezTerm', find: (p) => findExecutable('wezterm', [], p), launch: (path, cwd) => launchDetached(path, ['start', '--cwd', cwd]) },
  { id: 'gnome-terminal', name: 'GNOME Terminal', find: (p) => findExecutable('gnome-terminal', [], p), launch: (path, cwd) => launchDetached(path, [`--working-directory=${cwd}`]) },
  { id: 'konsole', name: 'Konsole', find: (p) => findExecutable('konsole', [], p), launch: (path, cwd) => launchDetached(path, ['--workdir', cwd]) },
  { id: 'xfce4-terminal', name: 'Xfce Terminal', find: (p) => findExecutable('xfce4-terminal', [], p), launch: (path, cwd) => launchDetached(path, [`--working-directory=${cwd}`]) },
  { id: 'x-terminal-emulator', name: 'Default terminal', find: (p) => findExecutable('x-terminal-emulator', [], p), launch: (path, cwd) => launchDetached(path, [], { cwd }) },
  { id: 'xterm', name: 'xterm', find: (p) => findExecutable('xterm', [], p), launch: (path, cwd) => launchDetached(path, [], { cwd }) },
];

function candidates(): ShellCandidate[] {
  return process.platform === 'win32' ? WINDOWS : process.platform === 'darwin' ? MAC : LINUX;
}

let cache: FoundShell[] | null = null;

export async function findShells(pathEnv: string | undefined, force = false): Promise<FoundShell[]> {
  if (cache && !force) return cache;
  const out: FoundShell[] = [];
  for (const c of candidates()) {
    const path = await c.find(pathEnv);
    if (path) out.push({ id: c.id, name: c.name, path });
  }
  cache = out;
  return out;
}

export async function openShell(id: string | null, customPath: string | null, cwd: string, pathEnv: string | undefined): Promise<void> {
  if (customPath) {
    await launchDetached(customPath, [], { cwd });
    return;
  }
  const shells = await findShells(pathEnv);
  const chosen = (id ? shells.find((s) => s.id === id) : null) ?? shells[0];
  if (!chosen) throw new Error('No terminal application was found. Configure one in Options → Integrations.');
  const candidate = candidates().find((c) => c.id === chosen.id)!;
  await candidate.launch(chosen.path, cwd);
}
