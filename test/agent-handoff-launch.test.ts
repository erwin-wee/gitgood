import { describe, expect, it, vi, beforeEach } from 'vitest';

const launchDetached = vi.fn(async () => {});
const startOnWindows = vi.fn(async () => {});

vi.mock('../src/main/exec', () => ({
  launchDetached: (...args: unknown[]) => launchDetached(...(args as [])),
  startOnWindows: (...args: unknown[]) => startOnWindows(...(args as [])),
  cmdQuote: (s: string) => `"${s.replace(/"/g, '""')}"`,
}));

/** Only these two "exist" on PATH, so findShells discovers a known-good terminal and an unsupported one. */
vi.mock('../src/main/tools', () => ({
  findExecutable: async (name: string) => (name === 'kitty' || name === 'x-terminal-emulator' ? `/usr/bin/${name}` : null),
}));

import { openShellWithCommand } from '../src/main/integrations/shells';
import { expandAgentCommand } from '../src/shared/agent-presets';

const FILE = '/repo/.git/gitgood/review/latest.md';
const build = (quoting: 'posix' | 'powershell' | 'cmd') => expandAgentCommand('claude "Read {file}. Do not commit."', FILE, quoting);
const EXPECTED = `claude "Read ${FILE}. Do not commit."`;

describe('openShellWithCommand', () => {
  beforeEach(() => {
    launchDetached.mockClear();
    startOnWindows.mockClear();
  });

  it('opens a custom terminal without the command and reports it was not launched', async () => {
    const res = await openShellWithCommand('custom', '/usr/bin/myterm', '/repo', build, undefined);
    expect(res).toEqual({ launched: false, command: EXPECTED });
    expect(launchDetached).toHaveBeenCalledWith('/usr/bin/myterm', [], { cwd: '/repo' });
  });

  it.skipIf(process.platform !== 'linux')('runs the command in a terminal it knows and returns exactly that command', async () => {
    const res = await openShellWithCommand('kitty', null, '/repo', build, undefined);
    expect(res).toEqual({ launched: true, command: EXPECTED });
    expect(launchDetached).toHaveBeenCalledWith('/usr/bin/kitty', ['--directory', '/repo', 'sh', '-c', `${EXPECTED}; exec "\${SHELL:-sh}"`], { cwd: '/repo' });
    expect(res.command).not.toContain('{file}');
  });

  it.skipIf(process.platform !== 'linux')('falls back to a plain terminal, with the command for the caller to copy, when the id is unknown to the command table', async () => {
    // 'x-terminal-emulator' is discovered by findShells on Linux but has no verified -e form.
    const res = await openShellWithCommand('x-terminal-emulator', null, '/repo', build, undefined);
    expect(res.launched).toBe(false);
    expect(res.command).toBe(EXPECTED);
  });

  it.skipIf(process.platform !== 'linux')('falls back to the first discovered terminal when the configured id is gone', async () => {
    const res = await openShellWithCommand('no-such-terminal', null, '/repo', build, undefined);
    expect(res).toEqual({ launched: true, command: EXPECTED });
  });
});
