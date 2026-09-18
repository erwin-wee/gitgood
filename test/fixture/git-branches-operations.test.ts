import { afterEach, describe, expect, it } from 'vitest';
import { branchExists, createBranch, deleteLocalBranch, getBranches, getCurrentBranchName, renameBranch } from '../../src/main/git/branches';
import { GitClient } from '../../src/main/git/git';
import {
  createTag,
  cherryPick,
  cherryPickAbort,
  cherryPickContinue,
  deleteTag,
  dropCommit,
  fetch,
  getStashes,
  getTags,
  markResolved,
  merge,
  mergeAbort,
  pull,
  push,
  rebase,
  rebaseAbort,
  rebaseContinue,
  reorderCommits,
  resolveStashRef,
  revert,
  squashCommits,
  stashApply,
  stashBranch,
  stashDrop,
  stashPop,
  stashPush,
  unresolve,
  useSide,
} from '../../src/main/git/operations';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

const noProgress = () => undefined;

describe.skipIf(!hasGitSync())('branches', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('creates, renames and deletes a local branch', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await createBranch(git, repo.path, 'feature', null, false);
    expect(await branchExists(git, repo.path, 'feature')).toBe(true);
    await renameBranch(git, repo.path, 'feature', 'feature-renamed');
    expect(await branchExists(git, repo.path, 'feature')).toBe(false);
    expect(await branchExists(git, repo.path, 'feature-renamed')).toBe(true);
    await deleteLocalBranch(git, repo.path, 'feature-renamed');
    expect(await branchExists(git, repo.path, 'feature-renamed')).toBe(false);
    expect(await getCurrentBranchName(git, repo.path)).toBe('main');
  });

  it('lists local and remote branches with ahead/behind tracking', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], remote: true });
    repo.commit({ message: 'local only', files: { 'a.txt': '2\n' } });
    const git = new GitClient(repo.tools());
    const branches = await getBranches(git, repo.path);
    const main = branches.find((b) => b.kind === 'local' && b.name === 'main')!;
    expect(main).toMatchObject({ isCurrent: true, ahead: 1, behind: 0, unpublished: false });
    const remoteMain = branches.find((b) => b.kind === 'remote' && b.name === 'origin/main');
    expect(remoteMain).toBeTruthy();

    await createBranch(git, repo.path, 'unpublished', null, false);
    const branches2 = await getBranches(git, repo.path);
    expect(branches2.find((b) => b.name === 'unpublished')).toMatchObject({ unpublished: true, isCurrent: false });
  });
});

describe.skipIf(!hasGitSync())('merge / rebase / cherry-pick / revert', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  async function divergedRepo(): Promise<TestRepo> {
    const r = await createRepo({ commits: [{ message: 'base', files: { 'f.txt': 'base\n' } }], branches: { feature: undefined } });
    r.commit({ message: 'main change', files: { 'f.txt': 'main\n' } });
    r.git(['checkout', 'feature']);
    r.commit({ message: 'feature change', files: { 'f.txt': 'feature\n' } });
    r.git(['checkout', 'main']);
    return r;
  }

  it('merges cleanly when there is no conflict', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'a.txt': '1\n' } }], branches: { feature: undefined } });
    repo.git(['checkout', 'feature']);
    repo.commit({ message: 'feature adds b', files: { 'b.txt': '1\n' } });
    repo.git(['checkout', 'main']);
    const git = new GitClient(repo.tools());
    const outcome = await merge(git, repo.path, 'feature', false);
    expect(outcome.status).toBe('complete');
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toContain('feature');
  });

  it('reports a conflict outcome and supports abort', async () => {
    repo = await divergedRepo();
    const git = new GitClient(repo.tools());
    const outcome = await merge(git, repo.path, 'feature', false);
    expect(outcome.status).toBe('conflicts');
    await mergeAbort(git, repo.path);
    expect(repo.git(['status', '--porcelain']).trim()).toBe('');
  });

  it('resolves a merge conflict with useSide/markResolved and continues', async () => {
    repo = await divergedRepo();
    const git = new GitClient(repo.tools());
    await merge(git, repo.path, 'feature', false);
    const originalConflicted = await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/f.txt`, 'utf8'));
    expect(originalConflicted).toContain('<<<<<<<');
    await useSide(git, repo.path, 'f.txt', 'theirs');
    const status1 = repo.git(['status', '--porcelain']).trim();
    expect(status1).toContain('M  f.txt');
    // Passing the originally-captured conflicted text restores it verbatim,
    // mirroring the "undo resolution" path the UI uses.
    await unresolve(git, repo.path, 'f.txt', originalConflicted);
    const content = await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/f.txt`, 'utf8'));
    expect(content).toBe(originalConflicted);
    await useSide(git, repo.path, 'f.txt', 'theirs');
    await markResolved(git, repo.path, ['f.txt']);
    const { mergeContinue } = await import('../../src/main/git/operations');
    const outcome = await mergeContinue(git, repo.path);
    expect(outcome.status).toBe('complete');
    const finalContent = await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/f.txt`, 'utf8'));
    expect(finalContent).toBe('feature\n');
  });

  it('rebases cleanly, and reports+continues through a conflict', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'a.txt': '1\n' } }], branches: { feature: undefined } });
    repo.git(['checkout', 'feature']);
    repo.commit({ message: 'feature commit', files: { 'b.txt': '1\n' } });
    repo.git(['checkout', 'main']);
    repo.commit({ message: 'main commit', files: { 'c.txt': '1\n' } });
    const git = new GitClient(repo.tools());
    repo.git(['checkout', 'feature']);
    const clean = await rebase(git, repo.path, 'main');
    expect(clean.status).toBe('complete');
    expect(repo.git(['log', '--format=%s', 'main..feature']).trim()).toBe('feature commit');

    // Now build a rebase that actually conflicts.
    repo.git(['checkout', 'main']);
    repo.commit({ message: 'main conflicting', files: { 'shared.txt': 'main\n' } });
    repo.git(['checkout', 'feature']);
    repo.commit({ message: 'feature conflicting', files: { 'shared.txt': 'feature\n' } });
    const conflicted = await rebase(git, repo.path, 'main');
    expect(conflicted.status).toBe('conflicts');
    await useSide(git, repo.path, 'shared.txt', 'theirs');
    const continued = await rebaseContinue(git, repo.path);
    expect(continued.status).toBe('complete');
  });

  it('aborts a conflicted rebase back to the original branch tip', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'f.txt': 'base\n' } }], branches: { feature: undefined } });
    repo.commit({ message: 'main change', files: { 'f.txt': 'main\n' } });
    repo.git(['checkout', 'feature']);
    repo.commit({ message: 'feature change', files: { 'f.txt': 'feature\n' } });
    const before = repo.git(['rev-parse', 'HEAD']).trim();
    const git = new GitClient(repo.tools());
    const outcome = await rebase(git, repo.path, 'main');
    expect(outcome.status).toBe('conflicts');
    await rebaseAbort(git, repo.path);
    expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(before);
  });

  it('cherry-picks a commit and reports+continues through a conflict', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'f.txt': 'base\n' } }], branches: { feature: undefined } });
    repo.commit({ message: 'main change', files: { 'f.txt': 'main\n' } });
    repo.git(['checkout', 'feature']);
    const featureSha = repo.commit({ message: 'feature change', files: { 'f.txt': 'feature\n' } });
    repo.git(['checkout', 'main']);
    const git = new GitClient(repo.tools());
    const outcome = await cherryPick(git, repo.path, [featureSha]);
    expect(outcome.status).toBe('conflicts');
    await useSide(git, repo.path, 'f.txt', 'theirs');
    const continued = await cherryPickContinue(git, repo.path);
    expect(continued.status).toBe('complete');
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('feature change');
  });

  it('aborts a cherry-pick', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'f.txt': 'base\n' } }], branches: { feature: undefined } });
    repo.commit({ message: 'main change', files: { 'f.txt': 'main\n' } });
    repo.git(['checkout', 'feature']);
    const featureSha = repo.commit({ message: 'feature change', files: { 'f.txt': 'feature\n' } });
    repo.git(['checkout', 'main']);
    const before = repo.git(['rev-parse', 'HEAD']).trim();
    const git = new GitClient(repo.tools());
    await cherryPick(git, repo.path, [featureSha]);
    await cherryPickAbort(git, repo.path);
    expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(before);
  });

  it('reverts a commit cleanly', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'a.txt': '1\n' } }, { message: 'add line', files: { 'a.txt': '1\n2\n' } }] });
    const git = new GitClient(repo.tools());
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const outcome = await revert(git, repo.path, sha);
    expect(outcome.status).toBe('complete');
    const content = await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/a.txt`, 'utf8'));
    expect(content).toBe('1\n');
  });
});

describe.skipIf(!hasGitSync())('interactive rebase automation (squash / reorder / reword / drop)', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('squashes commits into the target with a combined message, under plain Node', async () => {
    repo = await createRepo({
      commits: [
        { message: 'base', files: { 'a.txt': '1\n' } },
        { message: 'wip 1', files: { 'a.txt': '2\n' } },
        { message: 'wip 2', files: { 'a.txt': '3\n' } },
      ],
    });
    const shas = repo.git(['log', '--format=%H']).trim().split('\n');
    const [wip2, wip1] = shas; // newest first
    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    const outcome = await squashCommits(git, repo.path, { shas: [wip1, wip2], targetSha: wip1, message: 'Combined work\n' });
    expect(outcome.status).toBe('complete');
    expect(repo.git(['log', '--format=%s']).trim().split('\n')).toEqual(['Combined work', 'base']);
    const content = await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/a.txt`, 'utf8'));
    expect(content).toBe('3\n');
  });

  it('reorders commits', async () => {
    repo = await createRepo({
      commits: [
        { message: 'base', files: { 'a.txt': '1\n' } },
        { message: 'first', files: { 'b.txt': '1\n' } },
        { message: 'second', files: { 'c.txt': '1\n' } },
      ],
    });
    const shas = repo.git(['log', '--format=%H']).trim().split('\n');
    const [second, first] = shas; // display order newest-first: second, first, base
    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    // Move "first" so it displays before "second": first becomes the newer commit.
    const outcome = await reorderCommits(git, repo.path, [first], second);
    expect(outcome.status).toBe('complete');
    expect(repo.git(['log', '--format=%s']).trim().split('\n')).toEqual(['first', 'second', 'base']);
  });

  it('rewords a non-HEAD commit', async () => {
    repo = await createRepo({
      commits: [
        { message: 'base', files: { 'a.txt': '1\n' } },
        { message: 'typo', files: { 'b.txt': '1\n' } },
        { message: 'latest', files: { 'c.txt': '1\n' } },
      ],
    });
    const shas = repo.git(['log', '--format=%H']).trim().split('\n');
    const typoSha = shas[1];
    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    const outcome = await import('../../src/main/git/operations').then((m) => m.rewordCommit(git, repo!.path, typoSha, 'fixed typo'));
    expect(outcome.status).toBe('complete');
    expect(repo.git(['log', '--format=%s']).trim().split('\n')).toEqual(['latest', 'fixed typo', 'base']);
  });

  it('drops a commit', async () => {
    repo = await createRepo({
      commits: [
        { message: 'base', files: { 'a.txt': '1\n' } },
        { message: 'unwanted', files: { 'b.txt': '1\n' } },
        { message: 'keep', files: { 'c.txt': '1\n' } },
      ],
    });
    const shas = repo.git(['log', '--format=%H']).trim().split('\n');
    const unwantedSha = shas[1];
    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    const outcome = await dropCommit(git, repo.path, unwantedSha);
    expect(outcome.status).toBe('complete');
    expect(repo.git(['log', '--format=%s']).trim().split('\n')).toEqual(['keep', 'base']);
  });
});

describe.skipIf(!hasGitSync())('stash', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('pushes, lists, pops and drops a stash', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    await repo.write('a.txt', '2\n');
    const git = new GitClient(repo.tools());
    await stashPush(git, repo.path, 'my wip', false, null, 'main');
    expect((await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/a.txt`, 'utf8')))).toBe('1\n');
    let stashes = await getStashes(git, repo.path);
    expect(stashes).toHaveLength(1);
    expect(stashes[0].message).toBe('my wip');
    expect(stashes[0].createdByApp).toBe(true);
    expect(stashes[0].branch).toBe('main');

    const popped = await stashPop(git, repo.path, stashes[0].sha);
    expect(popped.status).toBe('complete');
    expect((await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/a.txt`, 'utf8')))).toBe('2\n');
    expect(await getStashes(git, repo.path)).toHaveLength(0);

    await stashPush(git, repo.path, 'again', false, null, 'main');
    stashes = await getStashes(git, repo.path);
    const applied = await stashApply(git, repo.path, stashes[0].sha);
    expect(applied.status).toBe('complete');
    await stashDrop(git, repo.path, stashes[0].sha);
    expect(await getStashes(git, repo.path)).toHaveLength(0);
  });

  it('resolves a stash SHA to its current stash@{N} ref and reports fileCount/untracked', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await stashPush(git, repo.path, 'tracked only', false, null, 'main');
    const [only] = await getStashes(git, repo.path);
    expect(only.fileCount).toBe(1);
    expect(only.untracked).toBe(false);
    expect(await resolveStashRef(git, repo.path, only.sha)).toBe('stash@{0}');
    expect(await resolveStashRef(git, repo.path, 'deadbeef')).toBeNull();
  });

  it('drops two stashes in sequence by SHA, unaffected by index shifting', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await stashPush(git, repo.path, 'first', false, null, 'main');
    await repo.write('a.txt', '3\n');
    await stashPush(git, repo.path, 'second', false, null, 'main');
    const stashes = await getStashes(git, repo.path);
    const first = stashes.find((s) => s.message === 'first')!;
    const second = stashes.find((s) => s.message === 'second')!;
    // Drop "first" (now stash@{1}) first, which shifts "second" from stash@{0}... but
    // exercise the interesting order: drop "second" first, then "first" by SHA.
    await stashDrop(git, repo.path, second.sha);
    const remaining = await getStashes(git, repo.path);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sha).toBe(first.sha);
    await stashDrop(git, repo.path, first.sha);
    expect(await getStashes(git, repo.path)).toHaveLength(0);
  });

  it('reports fileCount and untracked:true for a stash created with -u', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await repo.write('new-file.txt', 'brand new\n');
    await stashPush(git, repo.path, 'with untracked', true, null, 'main');
    const [only] = await getStashes(git, repo.path);
    expect(only.untracked).toBe(true);
    expect(only.fileCount).toBe(2);
  });

  it('drops a stash whose SHA is no longer listed with a classified stash-missing error', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await stashPush(git, repo.path, 'only', false, null, 'main');
    const [only] = await getStashes(git, repo.path);
    await stashDrop(git, repo.path, only.sha);
    const { GitError } = await import('../../src/main/git/git');
    await expect(stashDrop(git, repo.path, only.sha)).rejects.toMatchObject({ info: { code: 'stash-missing' } });
    await expect(stashPop(git, repo.path, only.sha)).rejects.toBeInstanceOf(GitError);
    await expect(stashApply(git, repo.path, only.sha)).rejects.toMatchObject({ info: { code: 'stash-missing' } });
  });

  it('creates a branch from a stash, checks it out with the stash applied, and drops the stash', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await stashPush(git, repo.path, 'wip', false, null, 'main');
    const [only] = await getStashes(git, repo.path);
    const outcome = await stashBranch(git, repo.path, only.sha, 'from-stash');
    expect(outcome.status).toBe('complete');
    expect(repo.git(['branch', '--show-current']).trim()).toBe('from-stash');
    expect(repo.git(['status', '--porcelain']).trim()).toContain('M a.txt');
    expect(await getStashes(git, repo.path)).toHaveLength(0);
  });

  it('reports branch-exists when the target branch name already exists', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], branches: { taken: undefined } });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await stashPush(git, repo.path, 'wip', false, null, 'main');
    const [only] = await getStashes(git, repo.path);
    await expect(stashBranch(git, repo.path, only.sha, 'taken')).rejects.toMatchObject({ info: { code: 'branch-exists' } });
    expect(await getStashes(git, repo.path)).toHaveLength(1);
  });
});

describe.skipIf(!hasGitSync())('tags', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('creates lightweight and annotated tags, and deletes them locally and remotely', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], remote: true });
    const git = new GitClient(repo.tools());
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    await createTag(git, repo.path, 'v1', sha, null);
    await createTag(git, repo.path, 'v2', sha, 'Release two');
    let tags = await getTags(git, repo.path);
    expect(tags.map((t) => t.name).sort()).toEqual(['v1', 'v2']);
    const annotated = tags.find((t) => t.name === 'v2')!;
    expect(annotated.annotated).toBe(true);
    expect(annotated.message).toBe('Release two');
    expect(tags.every((t) => t.unpushed)).toBe(true);

    const { pushTag } = await import('../../src/main/git/operations');
    await pushTag(git, repo.path, 'v1');
    tags = await getTags(git, repo.path);
    expect(tags.find((t) => t.name === 'v1')!.unpushed).toBe(false);

    await deleteTag(git, repo.path, 'v1', true);
    tags = await getTags(git, repo.path);
    expect(tags.map((t) => t.name)).toEqual(['v2']);
    const remoteTags = repo.git(['tag', '-l'], repo.remotePath!).trim();
    expect(remoteTags).toBe('');
  });
});

describe.skipIf(!hasGitSync())('fetch / push / pull against a bare origin', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('pushes a new branch upstream, then fetches and pulls remote changes', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }], remote: true });
    repo.commit({ message: 'second', files: { 'a.txt': '2\n' } });
    const git = new GitClient(repo.tools());
    await push(git, repo.path, { force: false, setUpstream: true, remote: 'origin', branch: 'main', tags: false }, noProgress);
    expect(repo.git(['log', '-1', '--format=%s'], repo.remotePath!).trim()).toBe('second');

    // Advance the remote independently (simulating a collaborator's push) and pull it in.
    repo.git(['clone', '-q', repo.remotePath!, `${repo.root}/clone`]);
    repo.git(['config', 'user.name', 'Test User'], `${repo.root}/clone`);
    repo.git(['config', 'user.email', 'test@example.com'], `${repo.root}/clone`);
    repo.git(['commit', '-q', '--allow-empty', '-m', 'from collaborator'], `${repo.root}/clone`);
    repo.git(['push', '-q'], `${repo.root}/clone`);

    await fetch(git, repo.path, 'origin', noProgress);
    expect(repo.git(['log', '-1', '--format=%s', 'origin/main']).trim()).toBe('from collaborator');
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('second');

    const pulled = await pull(git, repo.path, false, noProgress);
    expect(pulled.status).toBe('complete');
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('from collaborator');

    const upToDate = await pull(git, repo.path, false, noProgress);
    expect(upToDate.status).toBe('up-to-date');
  });

  it('reports a conflict outcome from pull --rebase', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'f.txt': '1\n' } }], remote: true });
    repo.git(['clone', '-q', repo.remotePath!, `${repo.root}/clone`]);
    repo.git(['config', 'user.name', 'Test User'], `${repo.root}/clone`);
    repo.git(['config', 'user.email', 'test@example.com'], `${repo.root}/clone`);
    repo.git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'remote change'], `${repo.root}/clone`);
    await import('node:fs/promises').then((m) => m.writeFile(`${repo!.root}/clone/f.txt`, '2\n'));
    repo.git(['add', '-A'], `${repo.root}/clone`);
    repo.git(['commit', '-q', '-m', 'remote edits f'], `${repo.root}/clone`);
    repo.git(['push', '-q'], `${repo.root}/clone`);

    await repo.write('f.txt', '3\n');
    repo.commit({ message: 'local edits f', files: { 'f.txt': '3\n' } });
    const git = new GitClient(repo.tools());
    const outcome = await pull(git, repo.path, true, noProgress);
    expect(outcome.status).toBe('conflicts');
  });
});
