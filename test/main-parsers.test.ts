import { describe, expect, it } from 'vitest';
import { parsePorcelainV2 } from '../src/main/git/status';
import { parseLog, parseNameStatusZ, parseNumstatZ } from '../src/main/git/log';
import { classifyGitError, TransferProgressParser } from '../src/main/git/git';
import { summarizeChecks } from '../src/main/gh/gh';
import { formatCommitMessage } from '../src/main/git/commit';

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
