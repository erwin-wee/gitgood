import { resolve } from 'node:path';

/**
 * The first existing directory a user passed on the command line (`gitgood <path>`), or null.
 *
 * `argv[0]` is the executable (the AppImage mount's binary, `gitgood.exe`, or `electron` in dev).
 * In dev (`electron .`, `process.defaultApp`) the first non-flag argument is the app path, which
 * would otherwise open GitGood's own checkout. Flags (including `--gitgood-server`) and protocol
 * links are skipped; relative paths resolve against `cwd` (the second instance's working directory).
 * Pure so it can be unit tested without Electron.
 */
export function pathFromArgv(argv: string[], opts: { defaultApp: boolean; cwd: string; isDirectory: (path: string) => boolean }): string | null {
  let skipAppPath = opts.defaultApp;
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    if (skipAppPath) {
      skipAppPath = false;
      continue;
    }
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(arg)) continue;
    const path = resolve(opts.cwd, arg);
    if (opts.isDirectory(path)) return path;
  }
  return null;
}
