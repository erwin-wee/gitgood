import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathFromArgv } from '../src/main/argv';

const dirs = new Set([resolve('/work/app'), resolve('/home/u/proj'), resolve('/gg')]);
const isDirectory = (p: string) => dirs.has(p);
const pick = (argv: string[], defaultApp = false, cwd = '/work') => pathFromArgv(argv, { defaultApp, cwd, isDirectory });

describe('pathFromArgv', () => {
  it('opens a directory passed to a packaged app (relative paths resolve against cwd)', () => {
    expect(pick(['/opt/GitGood/gitgood', '/home/u/proj'])).toBe(resolve('/home/u/proj'));
    expect(pick(['C:\\Program Files\\GitGood\\GitGood.exe', 'app'], false, '/work')).toBe(resolve('/work/app'));
  });

  it('does not treat the dev app path (`electron .`) as a repository, but takes the path after it', () => {
    expect(pick(['/node_modules/electron/dist/electron', '/gg'], true)).toBeNull();
    expect(pick(['/node_modules/electron/dist/electron', '/gg', '/home/u/proj'], true)).toBe(resolve('/home/u/proj'));
    expect(pick(['/node_modules/electron/dist/electron', '--inspect=9229', '/gg', '--no-sandbox'], true)).toBeNull();
  });

  it('ignores flags, the background-server flag, protocol links and missing paths (AppImage argv)', () => {
    expect(pick(['/tmp/.mount_GitGoodAbc/gitgood', '--no-sandbox'])).toBeNull();
    expect(pick(['/tmp/.mount_GitGoodAbc/gitgood', '--gitgood-server'])).toBeNull();
    expect(pick(['/tmp/.mount_GitGoodAbc/gitgood', 'gitgood://openRepo/https://github.com/o/r'])).toBeNull();
    expect(pick(['/tmp/.mount_GitGoodAbc/gitgood', '/nope', '/home/u/proj'])).toBe(resolve('/home/u/proj'));
    expect(pick(['/tmp/.mount_GitGoodAbc/gitgood', '--no-sandbox', '/home/u/proj'])).toBe(resolve('/home/u/proj'));
  });

  it('never treats the executable itself as a path', () => {
    expect(pick(['/home/u/proj'])).toBeNull();
  });
});
