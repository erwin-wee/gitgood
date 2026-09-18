import { describe, expect, it } from 'vitest';
import { parseBlamePorcelain } from '../src/main/git/blame';
import { ZERO_SHA } from '../src/shared/types';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function commitHeader(opts: { author?: string; authorMail?: string; authorTime?: string; authorTz?: string; summary?: string; previous?: string; filename?: string }): string[] {
  const lines: string[] = [];
  if (opts.author !== undefined) lines.push(`author ${opts.author}`);
  if (opts.authorMail !== undefined) lines.push(`author-mail <${opts.authorMail}>`);
  if (opts.authorTime !== undefined) lines.push(`author-time ${opts.authorTime}`);
  if (opts.authorTz !== undefined) lines.push(`author-tz ${opts.authorTz}`);
  if (opts.author !== undefined) lines.push(`committer ${opts.author}`);
  if (opts.authorMail !== undefined) lines.push(`committer-mail <${opts.authorMail}>`);
  if (opts.authorTime !== undefined) lines.push(`committer-time ${opts.authorTime}`);
  if (opts.authorTz !== undefined) lines.push(`committer-tz ${opts.authorTz}`);
  if (opts.summary !== undefined) lines.push(`summary ${opts.summary}`);
  if (opts.previous !== undefined) lines.push(`previous ${opts.previous}`);
  if (opts.filename !== undefined) lines.push(`filename ${opts.filename}`);
  return lines;
}

describe('parseBlamePorcelain', () => {
  it('groups a multi-line run under one hunk using the porcelain line count, and reuses cached metadata for a later run from the same commit', () => {
    const lines = [
      `${SHA_A} 1 1 2`,
      ...commitHeader({ author: 'Ada Lovelace', authorMail: 'ada@example.com', authorTime: '1224014729', authorTz: '+0200', summary: 'Initial commit', filename: 'file.txt' }),
      '\tline one',
      `${SHA_A} 2 2`,
      '\tline two',
      `${SHA_B} 3 3 1`,
      ...commitHeader({ author: 'Grace Hopper', authorMail: 'grace@example.com', authorTime: '1400000000', authorTz: '-0500', summary: 'Third line change', previous: `${SHA_A} file.txt`, filename: 'file.txt' }),
      '\tline three',
      // A later, separate run from the first commit (e.g. it also touches a line further down):
      `${SHA_A} 1 4 1`,
      '\tline four (same commit as run 1, later in the file)',
      '',
    ];
    const hunks = parseBlamePorcelain(lines.join('\n'));

    expect(hunks).toHaveLength(3);
    const [first, second, third] = hunks;

    expect(first).toMatchObject({ sha: SHA_A, shortSha: SHA_A.slice(0, 7), startLine: 1, lineCount: 2, originalPath: 'file.txt', previousSha: null });
    expect(first.author).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', date: '2008-10-14T22:05:29+02:00' });
    expect(first.summary).toBe('Initial commit');

    expect(second).toMatchObject({ sha: SHA_B, startLine: 3, lineCount: 1, originalPath: 'file.txt', previousSha: SHA_A });
    expect(second.author.name).toBe('Grace Hopper');

    // Reuses SHA_A's cached metadata (no headers were repeated for it) but is its own hunk/run.
    expect(third).toMatchObject({ sha: SHA_A, startLine: 4, lineCount: 1, originalPath: 'file.txt', previousSha: null });
    expect(third.author.name).toBe('Ada Lovelace');
  });

  it('labels not-yet-committed lines with the all-zero SHA', () => {
    const lines = [
      `${ZERO_SHA} 1 1 1`,
      ...commitHeader({ author: 'Not Committed Yet', authorMail: 'not.committed.yet', authorTime: '1700000000', authorTz: '+0000', summary: '', filename: 'file.txt' }),
      '\tworking tree line',
      '',
    ];
    const hunks = parseBlamePorcelain(lines.join('\n'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].sha).toBe(ZERO_SHA);
    expect(hunks[0].previousSha).toBeNull();
  });

  it('tolerates CRLF content lines without losing sync with the next header', () => {
    const lines = [
      `${SHA_A} 1 1 1`,
      ...commitHeader({ author: 'Ada Lovelace', authorMail: 'ada@example.com', authorTime: '1224014729', authorTz: '+0200', summary: 'CRLF file', filename: 'file.txt' }),
      '\tline with CRLF ending\r',
      `${SHA_B} 2 2 1`,
      ...commitHeader({ author: 'Grace Hopper', authorMail: 'grace@example.com', authorTime: '1400000000', authorTz: '-0500', summary: 'Second line', filename: 'file.txt' }),
      '\tsecond line\r',
      '',
    ];
    const hunks = parseBlamePorcelain(lines.join('\n'));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ sha: SHA_A, startLine: 1, lineCount: 1 });
    expect(hunks[1]).toMatchObject({ sha: SHA_B, startLine: 2, lineCount: 1 });
  });

  it('follows a rename via the filename header, attaching the historical path to the run', () => {
    const lines = [
      `${SHA_A} 1 1 3`,
      ...commitHeader({ author: 'Ada Lovelace', authorMail: 'ada@example.com', authorTime: '1224014729', authorTz: '+0200', summary: 'Add old-name.txt', filename: 'old-name.txt' }),
      '\tline one',
      `${SHA_A} 2 2`,
      '\tline two',
      `${SHA_A} 3 3`,
      '\tline three',
      '',
    ];
    const hunks = parseBlamePorcelain(lines.join('\n'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].originalPath).toBe('old-name.txt');
  });

  it('returns hunks sorted by starting line even when git emits them out of order', () => {
    const lines = [
      `${SHA_B} 5 5 1`,
      ...commitHeader({ author: 'Grace Hopper', authorMail: 'grace@example.com', authorTime: '1400000000', authorTz: '+0000', summary: 'Later run first in output', filename: 'file.txt' }),
      '\tline five',
      `${SHA_A} 1 1 2`,
      ...commitHeader({ author: 'Ada Lovelace', authorMail: 'ada@example.com', authorTime: '1224014729', authorTz: '+0000', summary: 'Earlier run second in output', filename: 'file.txt' }),
      '\tline one',
      `${SHA_A} 2 2`,
      '\tline two',
      '',
    ];
    const hunks = parseBlamePorcelain(lines.join('\n'));
    expect(hunks.map((h) => h.startLine)).toEqual([1, 5]);
  });
});
