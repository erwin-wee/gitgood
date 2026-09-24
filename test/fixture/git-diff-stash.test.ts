import { afterEach, describe, expect, it } from 'vitest';
import { getStashFileDiff, getStashFiles } from '../../src/main/git/diff';
import { reconstructOldLines } from '../../src/shared/diff/old-lines';
import { GitClient } from '../../src/main/git/git';
import { getStashes, stashPush } from '../../src/main/git/operations';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

const opts = { hideWhitespace: false };

describe.skipIf(!hasGitSync())('stash file listings and diffs', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('lists tracked and untracked files carried by a stash, including renames', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n', 'old-name.txt': 'same content for rename detection\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    repo.git(['mv', 'old-name.txt', 'new-name.txt']);
    await repo.write('untracked.txt', 'brand new, never committed\n');
    await stashPush(git, repo.path, 'mixed changes', true, null, 'main');
    const [stash] = await getStashes(git, repo.path);
    expect(stash.untracked).toBe(true);
    expect(stash.fileCount).toBe(3);

    const files = await getStashFiles(git, repo.path, stash.sha);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified' });
    const renamed = files.find((f) => f.path === 'new-name.txt');
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt' });
    expect(byPath.get('untracked.txt')).toMatchObject({ status: 'new' });
  });

  it('diffs a tracked stashed file against the stash parent', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('a.txt', '2\n');
    await stashPush(git, repo.path, 'wip', false, null, 'main');
    const [stash] = await getStashes(git, repo.path);
    const diff = await getStashFileDiff(git, repo.path, stash.sha, 'a.txt', opts);
    expect(diff.kind).toBe('text');
    if (diff.kind === 'text') {
      expect(diff.newContent).toBe('2\n');
      expect(reconstructOldLines(['2'], diff.hunks)).toEqual(['1']);
    }
  });

  it('renders an untracked stashed file as an added file', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await repo.write('untracked.txt', 'hello from the working tree\n');
    await stashPush(git, repo.path, 'with untracked', true, null, 'main');
    const [stash] = await getStashes(git, repo.path);
    const diff = await getStashFileDiff(git, repo.path, stash.sha, 'untracked.txt', opts);
    expect(diff.kind).toBe('text');
    if (diff.kind === 'text') {
      expect(diff.oldContent).toBeNull();
      expect(diff.newContent).toBe('hello from the working tree\n');
    }
  });
});
