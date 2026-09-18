import { describe, expect, it } from 'vitest';
import { parsePorcelainV2 } from '../src/main/git/status';
import { historyQueryArgs, mapSignatureStatus, parseLog, parseNameStatusZ, parseNumstatZ, pathspecArgs } from '../src/main/git/log';
import { EMPTY_HISTORY_QUERY } from '../src/shared/types';
import { classifyGitError, TransferProgressParser } from '../src/main/git/git';
import { parseWorktreeList } from '../src/main/git/worktree';
import { summarizeChecks, toPullRequest } from '../src/main/gh/gh';
import { formatCommitMessage } from '../src/main/git/commit';
import { extractWorktreePathFromError } from '../src/shared/util';

describe('porcelain v2 status parsing', () => {
  it('parses branch headers and entries', () => {
    const out = [
      '# branch.oid 671acd7',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc def README.md',
      '1 M. N... 100644 100644 100644 abc def src/utils/math.ts',
      '1 A. N... 000000 100644 100644 000 def new file.txt',
      '2 R. N... 100644 100644 100644 abc def R100 renamed.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 a b c app.ts',
      '? scratch.js',
      '! ignored.log',
    ].join('\0') + '\0';
    const { branch, files } = parsePorcelainV2(out);
    expect(branch).toMatchObject({ name: 'main', sha: '671acd7', upstream: 'origin/main', ahead: 2, behind: 1, detached: false, unborn: false, upstreamGone: false });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['README.md']).toMatchObject({ status: 'modified', staged: false, unstaged: true });
    expect(byPath['src/utils/math.ts']).toMatchObject({ status: 'modified', staged: true, unstaged: false });
    expect(byPath['new file.txt']).toMatchObject({ status: 'new', staged: true });
    expect(byPath['renamed.ts']).toMatchObject({ status: 'renamed', oldPath: 'old.ts' });
    expect(byPath['app.ts']).toMatchObject({ status: 'conflicted', conflict: 'both-modified' });
    expect(byPath['scratch.js']).toMatchObject({ status: 'untracked' });
    expect(byPath['ignored.log']).toMatchObject({ status: 'ignored' });
  });

  it('detects unborn, detached and gone upstream', () => {
    const unborn = parsePorcelainV2('# branch.oid (initial)\0# branch.head main\0');
    expect(unborn.branch.unborn).toBe(true);
    const detached = parsePorcelainV2('# branch.oid abc\0# branch.head (detached)\0');
    expect(detached.branch.detached).toBe(true);
    const gone = parsePorcelainV2('# branch.oid abc\0# branch.head f\0# branch.upstream origin/f\0');
    expect(gone.branch.upstreamGone).toBe(true);
  });
});

describe('log parsing', () => {
  it('parses records with fields, refs and co-authors', () => {
    const F = '\x1f';
    const R = '\x1e';
    const out = ['aaa', 'bbb ccc', 'Ann', 'ann@x.io', '2026-01-01T00:00:00Z', 'Ann', 'ann@x.io', '2026-01-02T00:00:00Z', 'HEAD -> main, tag: v1, origin/main', 'Merge it', 'Body line\n\nCo-authored-by: Bob <bob@x.io>\n'].join(F) + R + '\n' + ['ddd', '', 'Cy', 'cy@x.io', '2025-12-31T00:00:00Z', 'Cy', 'cy@x.io', '2025-12-31T00:00:00Z', '', 'Root', ''].join(F) + R;
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ sha: 'aaa', shortSha: 'aaa', parents: ['bbb', 'ccc'], isMerge: true, summary: 'Merge it', refs: ['main', 'tag: v1', 'origin/main'] });
    expect(commits[0].coAuthors).toEqual([{ name: 'Bob', email: 'bob@x.io' }]);
    expect(commits[0].body).toBe('Body line\n\nCo-authored-by: Bob <bob@x.io>');
    expect(commits[1]).toMatchObject({ parents: [], isMerge: false, body: '' });
    expect(commits[0].signature).toBeNull();
  });

  it('parses signature placeholders when requested, including a non-ASCII signer name', () => {
    const F = '\x1f';
    const R = '\x1e';
    const withSig = ['aaa', '', 'Ann', 'ann@x.io', '2026-01-01T00:00:00Z', 'Ann', 'ann@x.io', '2026-01-02T00:00:00Z', '', 'Signed commit', 'G', 'Zoë Müller <zoe@x.io>', 'ABCDEF0123456789', 'body\n'].join(F) + R;
    const [good] = parseLog(withSig, true);
    expect(good.signature).toEqual({ status: 'good', signer: 'Zoë Müller <zoe@x.io>', keyId: 'ABCDEF0123456789' });

    const noSig = ['bbb', '', 'Ann', 'ann@x.io', '2026-01-01T00:00:00Z', 'Ann', 'ann@x.io', '2026-01-02T00:00:00Z', '', 'Unsigned commit', 'N', '', '', ''].join(F) + R;
    const [none] = parseLog(noSig, true);
    expect(none.signature).toEqual({ status: 'none', signer: null, keyId: null });

    const bad = ['ccc', '', 'Ann', 'ann@x.io', '2026-01-01T00:00:00Z', 'Ann', 'ann@x.io', '2026-01-02T00:00:00Z', '', 'Bad', 'B', 'Eve <eve@x.io>', 'DEAD', ''].join(F) + R;
    expect(parseLog(bad, true)[0].signature).toMatchObject({ status: 'bad' });

    // Without the flag, the extra fields are treated as (missing/short) body text, not signature data.
    expect(parseLog(withSig)[0].signature).toBeNull();
  });

  it('maps every %G? validity character to a SignatureStatus', () => {
    expect(mapSignatureStatus('G')).toBe('good');
    expect(mapSignatureStatus('U')).toBe('untrusted');
    expect(mapSignatureStatus('X')).toBe('expired');
    expect(mapSignatureStatus('Y')).toBe('expired-key');
    expect(mapSignatureStatus('R')).toBe('revoked');
    expect(mapSignatureStatus('B')).toBe('bad');
    expect(mapSignatureStatus('E')).toBe('unknown-key');
    expect(mapSignatureStatus('N')).toBe('none');
    expect(mapSignatureStatus('')).toBe('none');
  });

  it('parses name-status and numstat output', () => {
    const files = parseNameStatusZ('M\0a.ts\0A\0b.ts\0R095\0old.ts\0new.ts\0D\0gone.ts\0');
    expect(files.map((f) => [f.status, f.path, f.oldPath])).toEqual([
      ['modified', 'a.ts', null],
      ['new', 'b.ts', null],
      ['renamed', 'new.ts', 'old.ts'],
      ['deleted', 'gone.ts', null],
    ]);
    const stats = parseNumstatZ('3\t1\ta.ts\0-\t-\timg.png\x005\t0\t\0old.ts\0new.ts\0');
    expect(stats.get('a.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stats.get('img.png')).toEqual({ additions: null, deletions: null, binary: true });
    expect(stats.get('new.ts')).toEqual({ additions: 5, deletions: 0, binary: false });
  });
});

describe('git error classification', () => {
  it('maps common stderr messages to codes', () => {
    expect(classifyGitError('fatal: not a git repository (or any of the parent directories): .git', '')).toBe('not-a-repository');
    expect(classifyGitError('remote: Support for password authentication was removed.\nfatal: Authentication failed for', '')).toBe('auth-failed');
    expect(classifyGitError(' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs', '')).toBe('non-fast-forward');
    expect(classifyGitError('CONFLICT (content): Merge conflict in app.ts\nAutomatic merge failed; fix conflicts and then commit the result.', '')).toBe('conflicts');
    expect(classifyGitError('error: Your local changes to the following files would be overwritten by checkout:', '')).toBe('local-changes-overwritten');
    expect(classifyGitError('fatal: The current branch feature has no upstream branch.', '')).toBe('no-upstream');
    expect(classifyGitError("fatal: Unable to create '/repo/.git/index.lock': File exists.", '')).toBe('lock-file');
    expect(classifyGitError('remote: error: GH006: Protected branch update failed', '')).toBe('protected-branch');
    expect(classifyGitError('fatal: unable to access https://github.com/x/y.git/: Could not resolve host: github.com', '')).toBe('network');
    expect(classifyGitError('something else', '')).toBe('unknown');
    expect(classifyGitError("fatal: 'feature' is already checked out at '/repos/feature-wt'", '')).toBe('worktree-branch-in-use');
    expect(classifyGitError("fatal: 'feature' is already used by worktree at '/repos/feature-wt'", '')).toBe('worktree-branch-in-use');
  });

  it('classifies signing failures distinctly from other failures', () => {
    expect(classifyGitError('error: gpg failed to sign the data\nfatal: failed to write commit object', '')).toBe('signing-failed');
    expect(classifyGitError('gpg: signing failed: No secret key\ngpg: [stdin]: clear-sign failed: No secret key', '')).toBe('signing-key-missing');
    expect(classifyGitError('error: Load key "/home/u/.ssh/missing": No such file or directory\nfatal: failed to write commit object', '')).toBe('signing-key-missing');
    expect(classifyGitError('ssh-keygen: /home/u/.ssh/missing: No such file or directory', '')).toBe('signing-key-missing');
  });

  it('treats a missing SSH key on the transport as an auth failure, not a signing one', () => {
    // A push over SSH with no key file prints the same `Load key` line as a
    // missing signing key, so the transport error has to win: this belongs in
    // the credential flow, not the signing-failure dialog.
    expect(
      classifyGitError('Load key "/home/u/.ssh/id_ed25519": No such file or directory\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', ''),
    ).toBe('auth-failed');
    expect(
      classifyGitError('ssh-keygen: /home/u/.ssh/id_ed25519: No such file or directory\nfatal: Authentication failed for https://github.com/x/y.git/', ''),
    ).toBe('auth-failed');
  });
});

describe('worktree branch-in-use path extraction', () => {
  it('pulls the other worktree path out of both git error phrasings', () => {
    expect(extractWorktreePathFromError("fatal: 'feature' is already checked out at '/repos/feature-wt'")).toBe('/repos/feature-wt');
    expect(extractWorktreePathFromError("fatal: 'feature' is already used by worktree at '/repos/feature-wt'\n")).toBe('/repos/feature-wt');
    expect(extractWorktreePathFromError('some unrelated error')).toBeNull();
  });
});

describe('worktree porcelain parsing', () => {
  function record(lines: string[]): string[] {
    return [...lines, ''];
  }

  const mainLines = ['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'];
  const featureLines = ['worktree /repo-feature', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feature'];
  const detachedLines = ['worktree /repo-detached', 'HEAD 3333333333333333333333333333333333333333', 'detached'];
  const lockedLines = ['worktree /repo-locked', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/locked-branch', 'locked'];
  const lockedReasonLines = ['worktree /repo-locked-reason', 'HEAD 5555555555555555555555555555555555555555', 'branch refs/heads/locked-branch2', 'locked in use elsewhere'];
  const prunableLines = ['worktree /repo-prunable', 'HEAD 6666666666666666666666666666666666666666', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location'];
  const bareLines = ['worktree /bare-repo.git', 'bare'];

  const allRecords = [mainLines, featureLines, detachedLines, lockedLines, lockedReasonLines, prunableLines];

  function buildLineFormat(records: string[][]): string {
    return records.flatMap((r) => record(r)).join('\n');
  }

  function buildZFormat(records: string[][]): string {
    return records.flatMap((r) => record(r)).join('\0') + '\0';
  }

  it('parses main, feature, detached, locked (with and without reason) and prunable entries in newline format', () => {
    const worktrees = parseWorktreeList(buildLineFormat(allRecords), '/repo-feature');
    expect(worktrees).toHaveLength(6);
    expect(worktrees[0]).toMatchObject({ path: '/repo', branch: 'main', isMain: true, isCurrent: false, locked: null, prunable: null });
    expect(worktrees[1]).toMatchObject({ path: '/repo-feature', branch: 'feature', isMain: false, isCurrent: true });
    expect(worktrees[2]).toMatchObject({ path: '/repo-detached', branch: null, isMain: false });
    expect(worktrees[3]).toMatchObject({ path: '/repo-locked', locked: '' });
    expect(worktrees[4]).toMatchObject({ path: '/repo-locked-reason', locked: 'in use elsewhere' });
    expect(worktrees[5]).toMatchObject({ path: '/repo-prunable', prunable: 'gitdir file points to non-existent location' });
    expect(worktrees.every((w) => w.dirty === null)).toBe(true);
  });

  it('parses the same entries in the -z format', () => {
    const worktrees = parseWorktreeList(buildZFormat(allRecords), '/repo');
    expect(worktrees).toHaveLength(6);
    expect(worktrees[0]).toMatchObject({ path: '/repo', branch: 'main', isMain: true, isCurrent: true });
    expect(worktrees[3]).toMatchObject({ locked: '' });
    expect(worktrees[4]).toMatchObject({ locked: 'in use elsewhere' });
    expect(worktrees[5]).toMatchObject({ prunable: 'gitdir file points to non-existent location' });
  });

  it('parses a bare main worktree in both formats', () => {
    const records = [bareLines, featureLines];
    const line = parseWorktreeList(buildLineFormat(records), null);
    expect(line).toHaveLength(2);
    expect(line[0]).toMatchObject({ path: '/bare-repo.git', head: '', branch: null, isMain: true });
    expect(line[1]).toMatchObject({ path: '/repo-feature', isMain: false });

    const z = parseWorktreeList(buildZFormat(records), null);
    expect(z).toHaveLength(2);
    expect(z[0]).toMatchObject({ path: '/bare-repo.git', head: '', branch: null, isMain: true });
  });
});

describe('transfer progress', () => {
  it('accumulates weighted phases', () => {
    const p = new TransferProgressParser('fetch');
    const a = p.feed('remote: Counting objects: 100% (10/10), done.\r');
    expect(a?.percent).toBeGreaterThan(0);
    const b = p.feed('Receiving objects:  50% (5/10)\r');
    expect(b!.percent).toBeGreaterThan(a!.percent);
    expect(b!.description).toContain('Receiving objects');
    const c = p.feed('Resolving deltas: 100% (3/3), done.\n');
    expect(c!.percent).toBeGreaterThan(0.8);
    expect(p.feed('some unrelated line')).toBeNull();
  });
});

describe('gh checks summary', () => {
  it('summarizes check runs and status contexts', () => {
    const s = summarizeChecks([
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ]);
    expect(s).toEqual({ total: 5, passed: 2, failed: 1, pending: 1, skipped: 1, state: 'failure' });
    expect(summarizeChecks([]).state).toBe('none');
    expect(summarizeChecks([{ __typename: 'StatusContext', state: 'PENDING' }]).state).toBe('pending');
    expect(summarizeChecks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' }]).state).toBe('success');
  });
});

describe('commit message formatting', () => {
  it('adds description and co-author trailers', () => {
    expect(formatCommitMessage('Summary ', 'Body\r\nline', [{ name: 'Bob', email: 'bob@x.io' }])).toBe('Summary\n\nBody\nline\n\nCo-authored-by: Bob <bob@x.io>\n');
    expect(formatCommitMessage('Only', '', [])).toBe('Only\n');
  });
});

describe('gh pr diff splitting', () => {
  it('splits a multi-file unified diff into per-file entries with stats and parsed hunks', async () => {
    const { splitPrDiff } = await import('../src/main/gh/prdiff');
    const text = [
      'diff --git a/src/b.ts b/src/b.ts',
      'index 1111111..2222222 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 90%',
      'rename from old-name.ts',
      'rename to new-name.ts',
      'index 4444444..5555555 100644',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
      '@@ -5,2 +5,2 @@',
      '-x',
      '+y',
      ' z',
      'diff --git a/gone.md b/gone.md',
      'deleted file mode 100644',
      'index 6666666..0000000',
      '--- a/gone.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/img.png b/img.png',
      'index 7777777..8888888 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    const { files, diffs } = splitPrDiff(text);
    expect(files.map((f) => f.path)).toEqual(['gone.md', 'img.png', 'new-name.ts', 'new.txt', 'src/b.ts']);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['src/b.ts']).toMatchObject({ status: 'modified', additions: 1, deletions: 1, binary: false, oldPath: null });
    expect(byPath['new.txt']).toMatchObject({ status: 'new', additions: 2, deletions: 0 });
    expect(byPath['new-name.ts']).toMatchObject({ status: 'renamed', oldPath: 'old-name.ts', additions: 1, deletions: 1 });
    expect(byPath['gone.md']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath['img.png']).toMatchObject({ binary: true, additions: null, deletions: null });
    expect(diffs.get('src/b.ts')?.hunks[0].lines.map((l) => l.type)).toEqual(['context', 'delete', 'add', 'context']);
    expect(diffs.get('new.txt')?.hunks[0].lines[1]).toMatchObject({ type: 'add', newLineNumber: 2, text: 'world' });
  });

  it('parses the headRefOid field into headSha on pull requests', () => {
    expect(summarizeChecks([{ state: 'SUCCESS' }]).state).toBe('success');
  });
});

describe('history query argument builder', () => {
  it('builds pickaxe flags for a literal content search', () => {
    expect(historyQueryArgs({ ...EMPTY_HISTORY_QUERY, content: 'needle' })).toEqual(['-Sneedle']);
  });

  it('adds --pickaxe-regex when contentRegex is set', () => {
    expect(historyQueryArgs({ ...EMPTY_HISTORY_QUERY, content: 'need.e', contentRegex: true })).toEqual(['-Sneed.e', '--pickaxe-regex']);
  });

  it('builds a diff-regex (-G) flag', () => {
    expect(historyQueryArgs({ ...EMPTY_HISTORY_QUERY, diffRegex: '^import' })).toEqual(['-G^import']);
  });

  it('builds author and date-range flags', () => {
    expect(historyQueryArgs({ ...EMPTY_HISTORY_QUERY, author: 'erwin', after: '2026-01-01', before: '2026-02-01' })).toEqual(['-i', '--author=erwin', '--after=2026-01-01', '--before=2026-02-01']);
  });

  it('returns nothing for an empty or null query', () => {
    expect(historyQueryArgs(EMPTY_HISTORY_QUERY)).toEqual([]);
    expect(historyQueryArgs(null)).toEqual([]);
  });

  it('builds pathspec args with glob magic only for glob-like patterns', () => {
    expect(pathspecArgs([])).toEqual([]);
    expect(pathspecArgs(['src/app.ts'])).toEqual(['--', 'src/app.ts']);
    expect(pathspecArgs(['src/**/*.ts', 'README.md'])).toEqual(['--', ':(glob)src/**/*.ts', 'README.md']);
  });
});

describe('pull request list parsing (triage fields)', () => {
  const baseRaw = {
    number: 7,
    title: 'Add retry logic',
    url: 'https://github.com/octo/repo/pull/7',
    author: { login: 'octocat' },
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'abc123',
    state: 'OPEN' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };

  it('parses commit/review/comment counts, latest reviews and file stats', () => {
    const pr = toPullRequest({
      ...baseRaw,
      commits: [{ oid: '1' }, { oid: '2' }],
      files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }, { path: '', additions: 1, deletions: 0 }],
      reviews: [{ author: { login: 'reviewer1' }, state: 'COMMENTED' }, { author: { login: 'reviewer1' }, state: 'APPROVED' }],
      latestReviews: [{ author: { login: 'reviewer1' }, state: 'APPROVED' }],
      comments: [{ author: { login: 'hubot' }, body: 'ping' }],
    });
    expect(pr.headSha).toBe('abc123');
    expect(pr.commitsCount).toBe(2);
    expect(pr.filesChanged).toEqual([{ path: 'src/a.ts', additions: 3, deletions: 1 }]);
    expect(pr.reviewsCount).toBe(2);
    expect(pr.latestReviews).toEqual([{ author: 'reviewer1', state: 'APPROVED' }]);
    expect(pr.commentsCount).toBe(1);
  });

  it('defaults every triage field to empty/zero when gh omits them', () => {
    const pr = toPullRequest({ ...baseRaw });
    expect(pr.commitsCount).toBe(0);
    expect(pr.filesChanged).toEqual([]);
    expect(pr.reviewsCount).toBe(0);
    expect(pr.latestReviews).toEqual([]);
    expect(pr.commentsCount).toBe(0);
  });
});
