/**
 * Parsing of the URLs GitGood is registered for (see `protocols` in
 * electron-builder.yml): GitHub's "Open with GitHub Desktop" links, our own
 * `gitgood://openRepo/...` equivalent, and the `gitgood://review/rerun` deep
 * link that terminal coding agents use to ask for a re-review after fixing
 * exported findings. Pure so it can be unit tested without Electron.
 */

export type ProtocolAction =
  | { kind: 'open-repo'; url: string; branch: string | null; filepath: string | null }
  /** Re-run the most recent AI review for the repository at `repoPath` (decoded, native path). */
  | { kind: 'review-rerun'; repoPath: string };

export function parseProtocolUrl(raw: string): ProtocolAction | null {
  const text = raw.trim();
  const rerun = /^gitgood:\/\/review\/rerun\/?\?(.*)$/i.exec(text);
  if (rerun) {
    // Decoded by hand rather than with URLSearchParams, which reads '+' as a
    // space; '+' is a legal character in a path on every platform.
    const raw = rerun[1].split('&').map((p) => p.split('=')).find((p) => p[0] === 'repo')?.[1];
    if (raw === undefined) return null;
    let repoPath: string;
    try {
      repoPath = decodeURIComponent(raw).trim();
    } catch {
      return null;
    }
    if (!repoPath) return null;
    return { kind: 'review-rerun', repoPath };
  }
  const m = /^(?:x-github-client|github-windows|github-mac|gitgood):\/\/openRepo\/(.+)$/i.exec(text);
  if (!m) return null;
  try {
    const target = new URL(m[1]);
    const branch = target.searchParams.get('branch');
    const filepath = target.searchParams.get('filepath');
    target.search = '';
    target.hash = '';
    return { kind: 'open-repo', url: target.toString().replace(/\/$/, ''), branch, filepath };
  } catch {
    return null;
  }
}

export function protocolUrlFromArgv(argv: string[]): string | null {
  return argv.find((a) => /^(gitgood|x-github-client|github-windows|github-mac):\/\//i.test(a)) ?? null;
}
