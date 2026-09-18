import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FoundShell } from '@shared/types';
import { cmdQuote, launchDetached, startOnWindows } from '../exec';
import { findExecutable } from '../tools';
import { buildCommandScript, canRunCommandIn, quotingFor, shellCommandInvocation, type Platform } from './shell-command';

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

/** Removes the temporary .command script once the terminal has had time to read it. */
function scheduleScriptCleanup(dir: string): void {
  const timer = setTimeout(() => {
    void rm(dir, { recursive: true, force: true }).catch(() => {
      /* best effort */
    });
  }, 60_000);
  timer.unref?.();
}

/**
 * Opens the terminal at `cwd` running the agent command (the "Fix with agent"
 * launcher). The command is built per terminal, because the shell that will
 * parse it decides how the file path inside it must be quoted; the command
 * actually used is returned so the caller can show or copy exactly that.
 * `launched` is false when GitGood only knows how to open that terminal
 * plainly, so the caller can hand the command over another way (clipboard).
 */
export async function openShellWithCommand(id: string | null, customPath: string | null, cwd: string, buildCommand: (quoting: ReturnType<typeof quotingFor>) => string, pathEnv: string | undefined): Promise<{ launched: boolean; command: string }> {
  const platform = process.platform as Platform;
  if (customPath) {
    await launchDetached(customPath, [], { cwd });
    return { launched: false, command: buildCommand(quotingFor('custom', platform)) };
  }
  const shells = await findShells(pathEnv);
  const chosen = (id ? shells.find((s) => s.id === id) : null) ?? shells[0];
  if (!chosen) throw new Error('No terminal application was found. Configure one in Options → Integrations.');
  const command = buildCommand(quotingFor(chosen.id, platform));
  if (!canRunCommandIn(chosen.id, platform)) {
    await openShell(chosen.id, null, cwd, pathEnv);
    return { launched: false, command };
  }
  let scriptPath: string | null = null;
  if (platform === 'darwin') {
    const dir = await mkdtemp(join(tmpdir(), 'gitgood-agent-'));
    scriptPath = join(dir, 'fix-with-agent.command');
    await writeFile(scriptPath, buildCommandScript(cwd, command), 'utf8');
    await chmod(scriptPath, 0o755);
    scheduleScriptCleanup(dir);
  }
  const inv = shellCommandInvocation(chosen.id, chosen.path, cwd, command, scriptPath, platform);
  if (!inv) {
    await openShell(chosen.id, null, cwd, pathEnv);
    return { launched: false, command };
  }
  if (inv.viaStart) await startOnWindows([cmdQuote(inv.file), ...inv.args], cwd);
  else await launchDetached(inv.file, inv.args, { cwd });
  return { launched: true, command };
}
