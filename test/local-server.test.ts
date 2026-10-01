import { describe, expect, it } from 'vitest';
import { managedPlist, managedRunCommand, managedUnit, parseRegQuery, serviceBackend } from '../src/main/local-server';

describe('managedUnit', () => {
  it('starts the bundled server in Node mode, immune to the AppImage adding --no-sandbox', () => {
    const unit = managedUnit('/opt/GitGood/gitgood');
    expect(unit).toContain('# Managed by the GitGood desktop app; rewritten on launch.');
    expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1');
    expect(unit).toMatch(/^ExecStart="\/opt\/GitGood\/gitgood" -e ".*process\.resourcesPath.*index\.mjs.*" -- --no-sandbox$/m);
  });

  it('quotes an executable path with spaces and escapes systemd specifiers', () => {
    const unit = managedUnit('/home/me/Apps/GitGood 100%.AppImage');
    expect(unit).toContain('ExecStart="/home/me/Apps/GitGood 100%%.AppImage" -e ');
  });
});

describe('macOS LaunchAgent', () => {
  it('runs the bundled server in Node mode at login, restarting after a failure', () => {
    const plist = managedPlist('/Applications/GitGood.app/Contents/MacOS/GitGood');
    expect(plist).toContain('Managed by the GitGood desktop app; rewritten on launch.');
    expect(plist).toContain('<key>Label</key>\n  <string>com.gitgood.server</string>');
    expect(plist).toContain('<string>/Applications/GitGood.app/Contents/MacOS/GitGood</string>\n    <string>-e</string>');
    expect(plist).toMatch(/<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it('escapes XML metacharacters in the executable path', () => {
    expect(managedPlist('/Apps/Git&Good <beta>/GitGood')).toContain('<string>/Apps/Git&amp;Good &lt;beta&gt;/GitGood</string>');
  });

  it('installs with bootstrap/kickstart and reloads a changed plist', () => {
    const svc = serviceBackend('darwin', { home: '/Users/me', uid: 501 })!;
    expect(svc.file).toBe('/Users/me/Library/LaunchAgents/com.gitgood.server.plist');
    const argvs = (rewritten: boolean) => svc.restart(rewritten, '/x').map((s) => s.argv.join(' '));
    expect(svc.install('/x').map((s) => s.argv.join(' '))).toEqual([
      'launchctl bootout gui/501/com.gitgood.server',
      'launchctl bootstrap gui/501 /Users/me/Library/LaunchAgents/com.gitgood.server.plist',
      'launchctl kickstart -k gui/501/com.gitgood.server',
    ]);
    expect(argvs(true)).toEqual(svc.install('/x').map((s) => s.argv.join(' ')));
    // Unchanged plist: the agent is already loaded at login, so only kick it.
    expect(argvs(false)).toEqual(['launchctl bootstrap gui/501 /Users/me/Library/LaunchAgents/com.gitgood.server.plist', 'launchctl kickstart -k gui/501/com.gitgood.server']);
    expect(svc.install('/x')[0].optional).toBe(true);
  });
});

describe('Windows login item', () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\Git'Good\\GitGood.exe";

  it('runs the GUI exe with the server flag (no console, no elevation)', () => {
    expect(managedRunCommand(exe)).toBe(`"${exe}" --gitgood-server`);
  });

  it('registers under HKCU Run, then replaces any running server with the new one', () => {
    const svc = serviceBackend('win32', { home: 'C:\\Users\\me' })!;
    expect(svc.file).toBeNull();
    const [register, stop, start] = svc.install(exe);
    expect(register.argv).toEqual(['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'GitGoodServer', '/t', 'REG_SZ', '/d', `"${exe}" --gitgood-server`, '/f']);
    // Only processes of this exe started with the flag are stopped; a server that is not running must not abort the restart.
    expect(stop.argv.at(-1)).toContain("$_.Name -eq 'GitGood.exe'");
    expect(stop.argv.at(-1)).toContain("-like '*--gitgood-server*'");
    expect(stop.optional).toBe(true);
    expect(start.argv.at(-1)).toBe("Start-Process -FilePath 'C:\\Users\\me\\AppData\\Local\\Programs\\Git''Good\\GitGood.exe' -ArgumentList '--gitgood-server'");
  });

  it('rewrites the registry value only when the definition changed', () => {
    const svc = serviceBackend('win32', { home: 'C:\\Users\\me' })!;
    expect(svc.restart(true, exe).map((s) => s.argv[0])).toEqual(['reg', 'powershell.exe', 'powershell.exe']);
    expect(svc.restart(false, exe).map((s) => s.argv[0])).toEqual(['powershell.exe', 'powershell.exe']);
  });

  it('reads the installed value back from reg query output', () => {
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    GitGoodServer    REG_SZ    "${exe}" --gitgood-server\r\n\r\n`;
    expect(parseRegQuery(out)).toBe(`"${exe}" --gitgood-server`);
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});

describe('systemd lifecycle', () => {
  it('keeps the existing Linux commands, honouring XDG_CONFIG_HOME', () => {
    const svc = serviceBackend('linux', { home: '/home/me', xdgConfigHome: '/cfg' })!;
    expect(svc.file).toBe('/cfg/systemd/user/gitgood-server.service');
    expect(svc.install('/x').map((s) => s.argv.join(' '))).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now gitgood-server', 'systemctl --user restart gitgood-server']);
    expect(svc.restart(true, '/x').map((s) => s.argv.at(-1))).toEqual(['daemon-reload', 'gitgood-server']);
    expect(svc.restart(false, '/x').map((s) => s.argv.join(' '))).toEqual(['systemctl --user restart gitgood-server']);
  });

  it('has no backend on other platforms', () => {
    expect(serviceBackend('freebsd', { home: '/home/me' })).toBeNull();
  });
});
