import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkingDiff, getCommitFileDiff } from '../../src/main/git/diff';
import { GitClient } from '../../src/main/git/git';
import { findLfsPatterns, getLfsFiles, getLfsStatus, lfsFetch, lfsInstallLocal, lfsPrune, lfsTrackedPaths, setLfsTracking } from '../../src/main/git/lfs';
import { getCommit, getCommitFiles } from '../../src/main/git/log';
import { getStatus } from '../../src/main/git/status';
import { createRepo, hasGitLfsSync, hasGitSync, type TestRepo } from '../helpers/repo';

/** A syntactically valid LFS pointer file's content, as git itself would store it whether or not git-lfs is installed (the pointer is a plain blob; only the smudge/clean filters that turn it into/from the real object require the extension). */
function pointer(oidSuffix: string, size = 12345): string {
  const oid = `${oidSuffix}${'0'.repeat(64 - oidSuffix.length)}`;
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

// ---------------------------------------------------------------------------
// Attribute detection and pointer handling: real git, no git-lfs extension
// needed (the pointer file's content and the .gitattributes filter=lfs
// pattern are ordinary git objects; only the smudge/clean transform that
// downloads/uploads the real object needs the extension).
// ---------------------------------------------------------------------------

describe.skipIf(!hasGitSync())('LFS detection and pointer diffs (no git-lfs extension required)', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('finds filter=lfs patterns from a committed .gitattributes', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { '.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n*.md text\n', 'a.psd': pointer('aa') } }] });
    const git = new GitClient(repo.tools());
    expect(await findLfsPatterns(git, repo.path)).toEqual(['*.psd']);
  });

  it('also picks up an uncommitted worktree .gitattributes', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    await repo.write('.gitattributes', '*.bin filter=lfs -text\n');
    const git = new GitClient(repo.tools());
    expect(await findLfsPatterns(git, repo.path)).toEqual(['*.bin']);
  });

  it('lfsTrackedPaths resolves attributes exactly like git check-attr, including untracked patterns', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { '.gitattributes': '*.psd filter=lfs -text\n', 'a.psd': pointer('aa'), 'b.txt': 'hello\n' } }] });
    const git = new GitClient(repo.tools());
    const tracked = await lfsTrackedPaths(git, repo.path, ['a.psd', 'b.txt']);
    expect(tracked.has('a.psd')).toBe(true);
    expect(tracked.has('b.txt')).toBe(false);
  });

  it('marks WorkingFile.lfs for a modified LFS-attributed file in status', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { '.gitattributes': '*.psd filter=lfs -text\n', 'a.psd': pointer('aa'), 'b.txt': 'hello\n' } }] });
    await repo.write('a.psd', pointer('bb'));
    await repo.write('b.txt', 'changed\n');
    const git = new GitClient(repo.tools());
    const status = await getStatus(git, repo.path);
    expect(status.files.find((f) => f.path === 'a.psd')?.lfs).toBe(true);
    expect(status.files.find((f) => f.path === 'b.txt')?.lfs).toBe(false);
  });

  it('marks CommitFile.lfs for an LFS-attributed file changed in a commit', async () => {
    repo = await createRepo({
      commits: [
        { message: 'init', files: { '.gitattributes': '*.psd filter=lfs -text\n', 'a.psd': pointer('aa'), 'b.txt': 'hello\n' } },
        { message: 'update', files: { 'a.psd': pointer('bb'), 'b.txt': 'hello again\n' } },
      ],
    });
    const git = new GitClient(repo.tools());
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const commit = await getCommit(git, repo.path, sha);
    const files = await getCommitFiles(git, repo.path, sha, commit.parents);
    expect(files.find((f) => f.path === 'a.psd')?.lfs).toBe(true);
    expect(files.find((f) => f.path === 'b.txt')?.lfs).toBe(false);
  });

  it('getWorkingDiff returns the lfs kind (not a text diff) for a changed pointer, missing locally since no object was ever downloaded', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { '.gitattributes': '*.psd filter=lfs -text\n', 'a.psd': pointer('aa') } }] });
    await repo.write('a.psd', pointer('bb'));
    const git = new GitClient(repo.tools());
    const status = await getStatus(git, repo.path);
    const file = status.files.find((f) => f.path === 'a.psd')!;
    const diff = await getWorkingDiff(git, repo.path, file, { hideWhitespace: false });
    expect(diff.kind).toBe('lfs');
    if (diff.kind === 'lfs') {
      expect(diff.oldOid).toBe('aa'.padEnd(64, '0'));
      expect(diff.newOid).toBe('bb'.padEnd(64, '0'));
      expect(diff.present).toBe(false);
      expect(diff.inner).toBeNull();
    }
  });

  it('getCommitFileDiff returns the lfs kind for a pointer changed within a commit', async () => {
    repo = await createRepo({
      commits: [
        { message: 'init', files: { '.gitattributes': '*.psd filter=lfs -text\n', 'a.psd': pointer('aa') } },
        { message: 'update', files: { 'a.psd': pointer('bb') } },
      ],
    });
    const git = new GitClient(repo.tools());
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const commit = await getCommit(git, repo.path, sha);
    const files = await getCommitFiles(git, repo.path, sha, commit.parents);
    const file = files.find((f) => f.path === 'a.psd')!;
    const diff = await getCommitFileDiff(git, repo.path, sha, commit.parents, file, { hideWhitespace: false });
    expect(diff.kind).toBe('lfs');
  });

  it('getCommitFileDiff renders an image diff inside the lfs kind when both objects are downloaded locally', async () => {
    repo = await createRepo({
      commits: [
        { message: 'init', files: { '.gitattributes': '*.png filter=lfs -text\n', 'a.png': pointer('aa') } },
        { message: 'update', files: { 'a.png': pointer('bb') } },
      ],
    });
    // A tiny 1x1 transparent PNG; the exact image content doesn't matter, only that both
    // "downloaded" LFS objects exist locally at the path our code reads them from.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const oldOid = 'aa'.padEnd(64, '0');
    const newOid = 'bb'.padEnd(64, '0');
    for (const oid of [oldOid, newOid]) {
      const dir = join(repo.path, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, oid), png);
    }
    const git = new GitClient(repo.tools());
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const commit = await getCommit(git, repo.path, sha);
    const files = await getCommitFiles(git, repo.path, sha, commit.parents);
    const file = files.find((f) => f.path === 'a.png')!;
    const diff = await getCommitFileDiff(git, repo.path, sha, commit.parents, file, { hideWhitespace: false });
    expect(diff.kind).toBe('lfs');
    if (diff.kind === 'lfs') {
      expect(diff.present).toBe(true);
      expect(diff.inner?.kind).toBe('image');
      if (diff.inner?.kind === 'image') {
        expect(diff.inner.oldImage?.bytes).toBe(png.length);
        expect(diff.inner.newImage?.bytes).toBe(png.length);
      }
    }
  });

  it('findLfsPatterns returns an empty array for a repository that does not use LFS', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    expect(await findLfsPatterns(git, repo.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behaviour that genuinely needs the `git-lfs` extension installed. Skipped
// on this machine (git-lfs is not installed here); the assertions below are
// still exercised for correctness whenever it is available.
// ---------------------------------------------------------------------------

describe.skipIf(!hasGitLfsSync())('git-lfs extension behaviour (skipped when git-lfs is not installed)', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('installs hooks, tracks a pattern, and reports status', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await lfsInstallLocal(git, repo.path);
    await setLfsTracking(git, repo.path, '*.psd', true);
    const status = await getLfsStatus(git, repo.path, { installed: true, version: 'test' });
    expect(status.hooksInstalled).toBe(true);
    expect(status.patterns).toContain('*.psd');
  });

  it('fetches and prunes LFS objects for a tracked file', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await lfsInstallLocal(git, repo.path);
    await setLfsTracking(git, repo.path, '*.bin', true);
    await repo.write('big.bin', 'binary-ish content\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'add big.bin']);
    const files = await getLfsFiles(git, repo.path);
    expect(files.some((f) => f.path === 'big.bin')).toBe(true);
    await lfsFetch(git, repo.path, 'pull', null, () => undefined);
    const pruneResult = await lfsPrune(git, repo.path, true);
    expect(pruneResult.objects).toBeGreaterThanOrEqual(0);
  });
});
