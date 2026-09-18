/**
 * Pure helpers behind "Fix with agent": how each known terminal is asked to
 * run a command in a new window that stays open afterwards, and which shell
 * the command will be parsed by (so the agent command can be quoted for that
 * shell rather than for the platform). Kept free of Electron and process
 * spawning so the argument shapes can be unit tested on any platform.
 * `shells.ts` turns the result into an actual launch.
 */
import type { CommandQuoting } from '@shared/agent-presets';

export type Platform = 'linux' | 'darwin' | 'win32';

export interface ShellInvocation {
  file: string;
  args: string[];
  /** When true the tokens go through `start` on Windows (see exec.ts startOnWindows) instead of a direct spawn. */
  viaStart?: boolean;
}

/** The command followed by an interactive shell, so the window does not close when the agent exits. */
export function keepOpenPosix(command: string): string {
  return `${command}; exec "\${SHELL:-sh}"`;
}

/** Body of the `.command` script macOS Terminal/iTerm open with `open -a`. */
export function buildCommandScript(cwd: string, command: string): string {
  return ['#!/bin/sh', `cd '${cwd.replace(/'/g, `'\\''`)}' || exit 1`, command, 'exec "${SHELL:-sh}"', ''].join('\n');
}

function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Which shell will parse the agent command in this terminal, so the file path
 * substituted into it can be escaped for that shell. Answered for every
 * terminal GitGood knows, including the ones it cannot start a command in
 * (their command is only copied to the clipboard, but it still has to be
 * pasteable).
 */
export function quotingFor(id: string, platform: Platform): CommandQuoting {
  if (platform !== 'win32') return 'posix';
  // Windows Terminal is given `cmd /k <command>`; Git Bash is a POSIX shell.
  if (id === 'powershell') return 'powershell';
  if (id === 'gitbash') return 'posix';
  return 'cmd';
}

/**
 * Returns how to launch terminal `id` (from shells.ts) at `cwd` running
 * `command`, or null when GitGood does not know a reliable way for that
 * terminal (the caller then opens it plainly and copies the command).
 * `scriptPath` is the pre-written `.command` file required by the macOS
 * terminals. `platform` disambiguates ids that exist on more than one
 * platform with different launch semantics (Ghostty is a binary on Linux and
 * an application bundle on macOS).
 */
export function shellCommandInvocation(id: string, shellPath: string, cwd: string, command: string, scriptPath: string | null = null, platform: Platform = process.platform as Platform): ShellInvocation | null {
  const sh = ['sh', '-c', keepOpenPosix(command)];
  if (platform === 'linux') {
    switch (id) {
      case 'ghostty':
        return { file: shellPath, args: [`--working-directory=${cwd}`, '-e', ...sh] };
      case 'alacritty':
        return { file: shellPath, args: ['--working-directory', cwd, '-e', ...sh] };
      case 'kitty':
        return { file: shellPath, args: ['--directory', cwd, ...sh] };
      case 'foot':
        return { file: shellPath, args: ['-D', cwd, ...sh] };
      case 'wezterm':
        return { file: shellPath, args: ['start', '--cwd', cwd, '--', ...sh] };
      case 'gnome-terminal':
        return { file: shellPath, args: [`--working-directory=${cwd}`, '--', ...sh] };
      case 'konsole':
        return { file: shellPath, args: ['--workdir', cwd, '-e', ...sh] };
      case 'xfce4-terminal':
        return { file: shellPath, args: [`--working-directory=${cwd}`, '-x', ...sh] };
      case 'xterm':
        return { file: shellPath, args: ['-e', ...sh] };
      // x-terminal-emulator: the Debian alternative points at any terminal, whose -e semantics differ.
      default:
        return null;
    }
  }
  if (platform === 'darwin') {
    // Terminal and iTerm run an executable .command file; Warp and the macOS
    // Ghostty bundle have no documented way to run one command and stay open,
    // and `shellPath` there is an .app directory that cannot be spawned.
    if (id === 'terminal') return scriptPath ? { file: 'open', args: ['-a', 'Terminal', scriptPath] } : null;
    if (id === 'iterm') return scriptPath ? { file: 'open', args: ['-a', 'iTerm', scriptPath] } : null;
    return null;
  }
  switch (id) {
    case 'wt':
      return { file: shellPath, args: ['-d', cmdQuote(cwd), 'cmd', '/k', command], viaStart: true };
    case 'powershell':
      return { file: shellPath, args: ['-NoExit', '-Command', command], viaStart: true };
    case 'cmd':
      return { file: shellPath, args: ['/k', command], viaStart: true };
    // Git Bash: no documented way to run a command and keep the window open.
    default:
      return null;
  }
}

/** Whether `shellCommandInvocation` knows this terminal at all (used to decide before writing the macOS script). */
export function canRunCommandIn(id: string, platform: Platform = process.platform as Platform): boolean {
  return shellCommandInvocation(id, 'x', '/', 'true', '/tmp/x.command', platform) !== null;
}
