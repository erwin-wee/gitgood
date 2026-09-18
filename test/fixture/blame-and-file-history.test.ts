import { afterEach, describe, expect, it } from 'vitest';
import { getBlame, getBlameResult, readFileAtCommit } from '../../src/main/git/blame';
import { GitClient } from '../../src/main/git/git';
import { getHistory, getPathHistory } from '../../src/main/git/log';
import { ZERO_SHA } from '../../src/shared/types';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

describe.skipIf(!hasGitSync())('file history follows renames', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('getHistory with follow returns commits from before and after a rename', async () => {
    const content = 'shared content across the rename\n';
    repo = await createRepo({
      commits: [
        { message: 'add old.txt', files: { 'old.txt': content } },
        { message: 'rename to new.txt', remove: ['old.txt'], files: { 'new.txt': content } },
        { message: 'modify new.txt', files: { 'new.txt': `${content}more\n` } },
      ],
    });
    const git = new GitClient(repo.tools());
    const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: 'new.txt', search: null, follow: true });
    expect(page.commits.map((c) => c.summary)).toEqual(['modify new.txt', 'rename to new.txt', 'add old.txt']);

    // Without --follow, history stops at the rename boundary.
    const withoutFollow = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 10, path: 'new.txt', search: null, follow: false });
    expect(withoutFollow.commits.map((c) => c.summary)).toEqual(['modify new.txt', 'rename to new.txt']);
  });

  it('getPathHistory maps each commit to the path the file had at that commit', async () => {
    const content = 'shared content across the rename\n';
    repo = await createRepo({
      commits: [
        { message: 'add old.txt', files: { 'old.txt': content } },
        { message: 'rename to new.txt', remove: ['old.txt'], files: { 'new.txt': content } },
        { message: 'modify new.txt', files: { 'new.txt': `${content}more\n` } },
      ],
    });
    const git = new GitClient(repo.tools());
    const shas = repo.git(['log', '--format=%H']).trim().split('\n'); // newest first: modify, rename, add
    const entries = await getPathHistory(git, repo.path, 'new.txt');
    const byPath = new Map(entries.map((e) => [e.sha, e.path]));
    expect(byPath.get(shas[2])).toBe('old.txt'); // add old.txt
    expect(byPath.get(shas[1])).toBe('new.txt'); // rename commit lands on the new name
    expect(byPath.get(shas[0])).toBe('new.txt'); // modify new.txt
  });
});

describe.skipIf(!hasGitSync())('readFileAtCommit', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('returns text content for a text file', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'hello world\n' } }] });
    const git = new GitClient(repo.tools());
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const result = await readFileAtCommit(git, repo.path, sha, 'a.txt');
    expect(result).toEqual({ content: 'hello world\n', binary: false, bytes: 12 });
  });

  it('reports binary files without returning their content', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'text\n' } }] });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(repo.path, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    repo.git(['add', 'image.bin']);
    repo.git(['commit', '-q', '-m', 'add binary']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const result = await readFileAtCommit(git(repo), repo.path, sha, 'image.bin');
    expect(result.binary).toBe(true);
    expect(result.content).toBeNull();
  });
});

function git(repo: TestRepo): GitClient {
  return new GitClient(repo.tools());
}

describe.skipIf(!hasGitSync())('blame', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('attributes each line to the commit that last changed it, and re-blames at a parent', async () => {
    repo = await createRepo({
      commits: [
        { message: 'add file', files: { 'f.txt': 'line one\nline two\nline three\n' } },
        { message: 'change line two', files: { 'f.txt': 'line one\nLINE TWO CHANGED\nline three\n' } },
      ],
    });
    const g = git(repo);
    const shas = repo.git(['log', '--format=%H']).trim().split('\n'); // [second, first]
    const hunks = await getBlame(g, repo.path, 'f.txt', null, false);
    const byLine = new Map(hunks.flatMap((h) => Array.from({ length: h.lineCount }, (_, i) => [h.startLine + i, h.sha] as const)));
    expect(byLine.get(1)).toBe(shas[1]); // line one: from the first commit
    expect(byLine.get(2)).toBe(shas[0]); // line two: changed in the second commit
    expect(byLine.get(3)).toBe(shas[1]); // line three: from the first commit

    // Blaming at the first commit only ever attributes to that commit.
    const atFirst = await getBlame(g, repo.path, 'f.txt', shas[1], false);
    expect(atFirst.every((h) => h.sha === shas[1])).toBe(true);
  });

  it('marks uncommitted working-tree lines with the zero SHA', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'f.txt': 'a\nb\nc\n' } }] });
    await repo.write('f.txt', 'a\nCHANGED\nc\n');
    const result = await getBlameResult(git(repo), repo.path, 'f.txt', null, false);
    const changed = result.hunks.find((h) => h.startLine <= 2 && 2 < h.startLine + h.lineCount);
    expect(changed?.sha).toBe(ZERO_SHA);
  });

  it('flags binary and too-large files instead of computing blame', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'f.txt': 'a\n' } }] });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(repo.path, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    repo.git(['add', 'bin.dat']);
    repo.git(['commit', '-q', '-m', 'add binary'], repo.path);
    const result = await getBlameResult(git(repo), repo.path, 'bin.dat', null, false);
    expect(result.binary).toBe(true);
    expect(result.hunks).toEqual([]);
  });
});
