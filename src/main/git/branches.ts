import type { Branch } from '@shared/types';
import type { GitClient } from './git';

const F = '\x1f';

function parseTrack(track: string): { ahead: number | null; behind: number | null; gone: boolean } {
  if (!track) return { ahead: 0, behind: 0, gone: false };
  if (/gone/.test(track)) return { ahead: null, behind: null, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? parseInt(ahead[1], 10) : 0, behind: behind ? parseInt(behind[1], 10) : 0, gone: false };
}

export async function getBranches(git: GitClient, repoPath: string): Promise<Branch[]> {
  const format = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso-strict)', '%(subject)', '%(authorname)', '%(HEAD)', '%(symref)'].join('%1f');
  const out = await git.stdout(repoPath, ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'], { readOnly: true });
  const defaultBranch = await getDefaultBranch(git, repoPath);
  const branches: Branch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(F);
    const refname = f[0];
    if (f[8]) continue; // symbolic refs like origin/HEAD
    const isRemote = refname.startsWith('refs/remotes/');
    const name = refname.replace(/^refs\/(heads|remotes)\//, '');
    const remote = isRemote ? name.split('/')[0] : null;
    const track = parseTrack(f[3]);
    branches.push({
      name,
      kind: isRemote ? 'remote' : 'local',
      remote,
      sha: f[1],
      upstream: f[2] || null,
      isCurrent: f[7] === '*',
      lastCommitDate: f[4],
      lastCommitSubject: f[5],
      lastCommitAuthor: f[6],
      ahead: track.ahead,
      behind: track.behind,
      isDefault: !isRemote && defaultBranch !== null && name === defaultBranch,
      unpublished: !isRemote && !f[2],
      upstreamGone: track.gone,
    });
  }
  return branches;
}

/** Local branch names already merged into `ref` (typically the default branch), via `git branch --merged`. */
export async function getMergedBranchNames(git: GitClient, repoPath: string, ref: string): Promise<Set<string>> {
  const out = await git.tryRun(repoPath, ['branch', '--merged', ref, '--format=%(refname:short)'], { readOnly: true, quiet: true });
  if (!out) return new Set();
  return new Set(out.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

export async function getDefaultBranch(git: GitClient, repoPath: string): Promise<string | null> {
  const head = await git.tryRun(repoPath, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { readOnly: true });
  if (head && head.stdout.trim()) return head.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    const exists = await git.tryRun(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], { readOnly: true });
    if (exists) return candidate;
    const remoteExists = await git.tryRun(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], { readOnly: true });
    if (remoteExists) return candidate;
  }
  const configured = await git.tryRun(repoPath, ['config', '--get', 'init.defaultBranch'], { readOnly: true });
  return configured?.stdout.trim() || null;
}

export async function createBranch(git: GitClient, repoPath: string, name: string, startPoint: string | null, checkout: boolean): Promise<void> {
  if (checkout) {
    await git.run(repoPath, ['checkout', '-b', name, ...(startPoint ? [startPoint] : [])]);
  } else {
    await git.run(repoPath, ['branch', name, ...(startPoint ? [startPoint] : [])]);
  }
}

export async function checkoutBranch(git: GitClient, repoPath: string, name: string): Promise<void> {
  await git.run(repoPath, ['checkout', name]);
}

/** Checks out a remote branch as a new tracking local branch (or the existing local one). */
export async function checkoutRemoteBranch(git: GitClient, repoPath: string, remoteBranch: string): Promise<string> {
  const slash = remoteBranch.indexOf('/');
  const local = slash === -1 ? remoteBranch : remoteBranch.slice(slash + 1);
  const localExists = await git.tryRun(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${local}`], { readOnly: true });
  if (localExists) {
    await git.run(repoPath, ['checkout', local]);
  } else {
    await git.run(repoPath, ['checkout', '-b', local, '--track', remoteBranch]);
  }
  return local;
}

export async function renameBranch(git: GitClient, repoPath: string, oldName: string, newName: string): Promise<void> {
  await git.run(repoPath, ['branch', '-m', oldName, newName]);
}

export async function deleteLocalBranch(git: GitClient, repoPath: string, name: string): Promise<void> {
  await git.run(repoPath, ['branch', '-D', name]);
}

export async function deleteRemoteBranch(git: GitClient, repoPath: string, remote: string, name: string): Promise<void> {
  await git.run(repoPath, ['push', remote, '--delete', name]);
}

export async function getCurrentBranchName(git: GitClient, repoPath: string): Promise<string | null> {
  const out = await git.tryRun(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD'], { readOnly: true });
  return out?.stdout.trim() || null;
}

export async function branchExists(git: GitClient, repoPath: string, name: string): Promise<boolean> {
  return (await git.tryRun(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { readOnly: true })) !== null;
}

export async function getUpstreamRemote(git: GitClient, repoPath: string, branch: string): Promise<string | null> {
  const out = await git.tryRun(repoPath, ['config', '--get', `branch.${branch}.remote`], { readOnly: true });
  return out?.stdout.trim() || null;
}
