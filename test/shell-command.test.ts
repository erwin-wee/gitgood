import { describe, expect, it } from 'vitest';
import { buildCommandScript, canRunCommandIn, keepOpenPosix, quotingFor, shellCommandInvocation } from '../src/main/integrations/shell-command';

const CMD = 'claude "Read the file /home/dev/my app/.git/gitgood/review/latest.md and fix every finding it lists. Do not commit."';
const CWD = '/home/dev/my app';

describe('shellCommandInvocation', () => {
  it('passes the command as one sh -c argument followed by an interactive shell on Linux terminals', () => {
    const wrapped = keepOpenPosix(CMD);
    expect(wrapped).toBe(`${CMD}; exec "\${SHELL:-sh}"`);
    expect(shellCommandInvocation('ghostty', '/usr/bin/ghostty', CWD, CMD, null, 'linux')).toEqual({ file: '/usr/bin/ghostty', args: [`--working-directory=${CWD}`, '-e', 'sh', '-c', wrapped] });
    expect(shellCommandInvocation('alacritty', '/usr/bin/alacritty', CWD, CMD, null, 'linux')).toEqual({ file: '/usr/bin/alacritty', args: ['--working-directory', CWD, '-e', 'sh', '-c', wrapped] });
    expect(shellCommandInvocation('kitty', '/usr/bin/kitty', CWD, CMD, null, 'linux')?.args).toEqual(['--directory', CWD, 'sh', '-c', wrapped]);
    expect(shellCommandInvocation('foot', '/usr/bin/foot', CWD, CMD, null, 'linux')?.args).toEqual(['-D', CWD, 'sh', '-c', wrapped]);
    expect(shellCommandInvocation('wezterm', '/usr/bin/wezterm', CWD, CMD, null, 'linux')?.args).toEqual(['start', '--cwd', CWD, '--', 'sh', '-c', wrapped]);
    expect(shellCommandInvocation('gnome-terminal', '/usr/bin/gnome-terminal', CWD, CMD, null, 'linux')?.args).toEqual([`--working-directory=${CWD}`, '--', 'sh', '-c', wrapped]);
    expect(shellCommandInvocation('konsole', '/usr/bin/konsole', CWD, CMD, null, 'linux')?.args).toEqual(['--workdir', CWD, '-e', 'sh', '-c', wrapped]);
    expect(shellCommandInvocation('xfce4-terminal', '/usr/bin/xfce4-terminal', CWD, CMD, null, 'linux')?.args).toEqual([`--working-directory=${CWD}`, '-x', 'sh', '-c', wrapped]);
    expect(shellCommandInvocation('xterm', '/usr/bin/xterm', CWD, CMD, null, 'linux')?.args).toEqual(['-e', 'sh', '-c', wrapped]);
  });

  it('has no verified form for the Debian alternative, Git Bash, Warp or a custom path, so callers fall back', () => {
    for (const id of ['x-terminal-emulator', 'custom', 'unknown']) {
      expect(shellCommandInvocation(id, '/x', CWD, CMD, '/tmp/s.command', 'linux')).toBeNull();
      expect(canRunCommandIn(id, 'linux')).toBe(false);
    }
    expect(canRunCommandIn('gitbash', 'win32')).toBe(false);
    expect(canRunCommandIn('warp', 'darwin')).toBe(false);
    expect(canRunCommandIn('ghostty', 'linux')).toBe(true);
    expect(canRunCommandIn('terminal', 'darwin')).toBe(true);
  });

  it('never launches the macOS Ghostty bundle with the Linux argument form', () => {
    // shells.ts uses the id 'ghostty' for a Linux binary and for /Applications/Ghostty.app,
    // which cannot be spawned; on macOS it must fall back instead.
    expect(shellCommandInvocation('ghostty', '/Applications/Ghostty.app', CWD, CMD, '/tmp/s.command', 'darwin')).toBeNull();
    expect(canRunCommandIn('ghostty', 'darwin')).toBe(false);
    expect(shellCommandInvocation('warp', '/Applications/Warp.app', CWD, CMD, '/tmp/s.command', 'darwin')).toBeNull();
    // Linux ids are not accidentally matched on Windows either.
    expect(shellCommandInvocation('kitty', 'kitty.exe', CWD, CMD, null, 'win32')).toBeNull();
  });

  it('reports which shell will parse the command, per terminal', () => {
    expect(quotingFor('ghostty', 'linux')).toBe('posix');
    expect(quotingFor('terminal', 'darwin')).toBe('posix');
    expect(quotingFor('powershell', 'win32')).toBe('powershell');
    expect(quotingFor('gitbash', 'win32')).toBe('posix');
    expect(quotingFor('wt', 'win32')).toBe('cmd');
    expect(quotingFor('cmd', 'win32')).toBe('cmd');
    expect(quotingFor('custom', 'win32')).toBe('cmd');
  });

  it('opens a .command script with the macOS terminals and requires the script', () => {
    expect(shellCommandInvocation('terminal', '/System/Applications/Utilities/Terminal.app', CWD, CMD, '/tmp/x/fix.command', 'darwin')).toEqual({ file: 'open', args: ['-a', 'Terminal', '/tmp/x/fix.command'] });
    expect(shellCommandInvocation('iterm', '/Applications/iTerm.app', CWD, CMD, '/tmp/x/fix.command', 'darwin')?.args).toEqual(['-a', 'iTerm', '/tmp/x/fix.command']);
    expect(shellCommandInvocation('terminal', '/x', CWD, CMD, null, 'darwin')).toBeNull();
    const script = buildCommandScript("/Users/dev/it's here", CMD);
    expect(script.split('\n')).toEqual(['#!/bin/sh', `cd '/Users/dev/it'\\''s here' || exit 1`, CMD, 'exec "${SHELL:-sh}"', '']);
  });

  it('goes through start on Windows with the command as the trailing tokens', () => {
    const cwd = 'C:\\Users\\Dev Name\\repo';
    const cmd = 'claude "Read the file C:\\Users\\Dev Name\\repo\\.git\\gitgood\\review\\latest.md and fix every finding it lists. Do not commit."';
    expect(shellCommandInvocation('wt', 'C:\\wt.exe', cwd, cmd, null, 'win32')).toEqual({ file: 'C:\\wt.exe', args: ['-d', `"${cwd}"`, 'cmd', '/k', cmd], viaStart: true });
    expect(shellCommandInvocation('powershell', 'pwsh.exe', cwd, cmd, null, 'win32')).toEqual({ file: 'pwsh.exe', args: ['-NoExit', '-Command', cmd], viaStart: true });
    expect(shellCommandInvocation('cmd', 'cmd.exe', cwd, cmd, null, 'win32')).toEqual({ file: 'cmd.exe', args: ['/k', cmd], viaStart: true });
  });
});
