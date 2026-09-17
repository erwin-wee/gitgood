import type { CommitOptions } from '@shared/types';
import { GitError, type GitClient } from './git';

export async function isUnborn(git: GitClient, repoPath: string): Promise<boolean> {
  const res = await git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'], { readOnly: true });
  return res === null;
}

export async function unstageAll(git: GitClient, repoPath: string): Promise<void> {
  if (await isUnborn(git, repoPath)) {
    await git.tryRun(repoPath, ['rm', '-r', '--cached', '--quiet', '--', '.']);
    return;
  }
  await git.run(repoPath, ['reset', '-q', '--', '.']);
}

export async function stageFiles(git: GitClient, repoPath: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  // Batch to stay well below command line limits on Windows.
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    await git.run(repoPath, ['add', '-A', '--', ...chunk]);
  }
}

export async function unstageFiles(git: GitClient, repoPath: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (await isUnborn(git, repoPath)) {
    await git.run(repoPath, ['rm', '-r', '--cached', '--quiet', '--', ...paths]);
    return;
  }
  await git.run(repoPath, ['reset', '-q', '--', ...paths]);
}

export async function applyPatchToIndex(git: GitClient, repoPath: string, patch: string): Promise<void> {
  await git.run(repoPath, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], { stdin: patch });
}

export async function applyPatchToWorktree(git: GitClient, repoPath: string, patch: string): Promise<void> {
  await git.run(repoPath, ['apply', '--unidiff-zero', '--whitespace=nowarn', '-'], { stdin: patch });
}

export function formatCommitMessage(summary: string, description: string, coAuthors: { name: string; email: string }[]): string {
  let message = summary.trim();
  const desc = description.replace(/\r\n/g, '\n').trim();
  if (desc) message += `\n\n${desc}`;
  if (coAuthors.length) {
    const trailers = coAuthors.map((c) => `Co-authored-by: ${c.name} <${c.email}>`).join('\n');
    message += `\n\n${trailers}`;
  }
  return `${message}\n`;
}

/**
 * Creates a commit from the selected files, mirroring GitHub Desktop: the index
 * is rebuilt from the selection so that the commit matches what the UI shows.
 */
export async function createCommit(git: GitClient, repoPath: string, opts: CommitOptions, mergeInProgress: boolean): Promise<string> {
  if (!mergeInProgress) await unstageAll(git, repoPath);
  const wholeFiles = opts.files.filter((p) => !(p in opts.partialPatches));
  await stageFiles(git, repoPath, wholeFiles);
  for (const [path, patch] of Object.entries(opts.partialPatches)) {
    if (!opts.files.includes(path)) continue;
    await applyPatchToIndex(git, repoPath, patch);
  }
  const message = formatCommitMessage(opts.summary, opts.description, opts.coAuthors);
  const args = ['commit', '-F', '-', '--cleanup=strip'];
  if (opts.amend) args.push('--amend');
  if (mergeInProgress && !opts.summary.trim()) {
    await git.run(repoPath, ['commit', '--no-edit']);
  } else {
    if (!opts.summary.trim() && !opts.amend) throw new GitError({ message: 'A commit summary is required.', command: 'git commit', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
    await git.run(repoPath, args, { stdin: message });
  }
  return (await git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
}

export async function undoLastCommit(git: GitClient, repoPath: string): Promise<void> {
  const parents = (await git.stdout(repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD'], { readOnly: true })).trim().split(' ');
  if (parents.length <= 1) {
    // Root commit: make the branch unborn again but keep the files staged.
    await git.run(repoPath, ['update-ref', '-d', 'HEAD']);
    return;
  }
  await git.run(repoPath, ['reset', '--soft', 'HEAD~1']);
}

export async function getLastCommitMessage(git: GitClient, repoPath: string): Promise<{ summary: string; body: string } | null> {
  const out = await git.tryRun(repoPath, ['log', '-1', '--format=%s%x1f%b'], { readOnly: true });
  if (!out) return null;
  const [summary, body] = out.stdout.split('\x1f');
  return { summary: summary ?? '', body: (body ?? '').replace(/\n+$/, '') };
}
