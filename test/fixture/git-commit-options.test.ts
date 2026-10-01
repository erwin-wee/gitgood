import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitFlags, createCommit, readCommitTemplate } from '../../src/main/git/commit';
import { getRangeFiles } from '../../src/main/git/diff';
import { GitClient } from '../../src/main/git/git';
import { createRepo, hasGitSync } from '../helpers/repo';

const opts = { summary: 'change', description: '', coAuthors: [], amend: false, files: ['a.txt'], partialPatches: {} };

describe('commitFlags', () => {
  it('combines signing override, sign-off and skip-hooks', () => {
    expect(commitFlags({})).toEqual([]);
    expect(commitFlags({ signOverride: 'unsigned', signoff: true, noVerify: true })).toEqual(['--no-gpg-sign', '--signoff', '--no-verify']);
    expect(commitFlags({ signOverride: 'sign' })).toEqual(['-S']);
  });
});

describe.skipIf(!hasGitSync())('commit options against real git', () => {
  it('adds Signed-off-by with signoff and bypasses a failing pre-commit hook with noVerify', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const hook = join(repo.path, '.git', 'hooks', 'pre-commit');
      await writeFile(hook, '#!/bin/sh\necho blocked >&2\nexit 1\n');
      await chmod(hook, 0o755);
      const git = new GitClient(repo.tools());
      await repo.write('a.txt', '2\n');
      await expect(createCommit(git, repo.path, { ...opts, signoff: true }, false)).rejects.toThrow();
      await createCommit(git, repo.path, { ...opts, signoff: true, noVerify: true }, false);
      expect(repo.git(['log', '-1', '--format=%B'])).toContain('Signed-off-by: Test User <test@example.com>');
      await repo.write('a.txt', '3\n');
      await createCommit(git, repo.path, { ...opts, noVerify: true }, false);
      expect(repo.git(['log', '-1', '--format=%B'])).not.toContain('Signed-off-by');
    } finally {
      await repo.dispose();
    }
  });

  it('reads commit.template relative to the repo, dropping comment lines; ignores missing, binary or absent templates', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    try {
      const git = new GitClient(repo.tools());
      expect(await readCommitTemplate(git, repo.path)).toBeNull();
      await repo.write('.gitmessage', 'feat: \n\nWhy:\n# Explain why\n');
      repo.git(['config', 'commit.template', '.gitmessage']);
      expect(await readCommitTemplate(git, repo.path)).toEqual({ summary: 'feat: ', description: 'Why:' });
      await repo.write('.gitmessage', '# only comments\n');
      expect(await readCommitTemplate(git, repo.path)).toBeNull();
      await repo.write('.gitmessage', 'bin\0ary');
      expect(await readCommitTemplate(git, repo.path)).toBeNull();
      repo.git(['config', 'commit.template', 'nope.txt']);
      expect(await readCommitTemplate(git, repo.path)).toBeNull();
    } finally {
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('getRangeFiles', () => {
  it('lists name-status entries for base...head, excluding changes only on base', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'keep.txt': '1\n', 'old.txt': 'x\n', 'gone.txt': 'y\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.commit({ message: 'feature', files: { 'keep.txt': '2\n', 'z-new.txt': 'n\n' }, remove: ['gone.txt'] });
      repo.git(['mv', 'old.txt', 'renamed.txt']);
      repo.commit({ message: 'rename', allowEmpty: true });
      repo.git(['checkout', 'main']);
      repo.commit({ message: 'main only', files: { 'main-only.txt': '1\n' } });
      const git = new GitClient(repo.tools());
      const files = await getRangeFiles(git, repo.path, 'main', 'feature');
      expect(files.map((f) => [f.path, f.status, f.oldPath])).toEqual([
        ['gone.txt', 'deleted', null],
        ['keep.txt', 'modified', null],
        ['renamed.txt', 'renamed', 'old.txt'],
        ['z-new.txt', 'new', null],
      ]);
    } finally {
      await repo.dispose();
    }
  });
});
