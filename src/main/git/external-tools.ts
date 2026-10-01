import type { GitClient } from './git';

export type ExternalToolSource = { kind: 'working' } | { kind: 'commit'; sha: string };

/** How long a tool launch has to fail (unknown tool, missing binary) before we report success and let it run on in the background. */
const EARLY_FAILURE_MS = 1500;

/** argv for `git difftool` on one file: the working tree against HEAD, or a commit against its first parent. */
export function difftoolArgs(path: string, source: ExternalToolSource): string[] {
  if (source.kind === 'commit' && !/^[0-9a-f]{4,64}$/i.test(source.sha)) throw new Error('Invalid commit id.');
  return ['difftool', '--no-prompt', ...(source.kind === 'commit' ? [`${source.sha}^!`] : ['HEAD']), '--', path];
}

/**
 * Starts `git difftool`/`git mergetool` without waiting for the tool to exit.
 * A failure within the first moments (no tool configured or installed) is thrown
 * to the caller; a later exit, successful or not, calls `onExit` (the merge tool
 * has rewritten files by then, so callers refresh status there).
 */
export async function launchGitTool(git: GitClient, repoPath: string, kind: 'diff' | 'merge', args: string[], onExit: () => void): Promise<void> {
  const configured = (await git.tryRun(repoPath, ['config', '--get', `${kind}.tool`], { readOnly: true }))?.stdout.trim();
  if (!configured) {
    const example = kind === 'diff' ? 'git config --global diff.tool meld' : 'git config --global merge.tool meld';
    throw new Error(`No ${kind} tool is configured. Set one in a terminal, e.g. "${example}" (replace meld with kdiff3, vscode, bc, ...); "git ${kind}tool --tool-help" lists the tools git knows.`);
  }
  const done = git.run(repoPath, args, { quiet: true }).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );
  const early = await Promise.race([done.then((err) => ({ err })), new Promise<null>((resolve) => setTimeout(() => resolve(null), EARLY_FAILURE_MS))]);
  if (early) {
    onExit();
    if (early.err) throw early.err;
    return;
  }
  void done.then(onExit);
}
