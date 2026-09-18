import { describe, expect, it } from 'vitest';
import type { Explanation } from '../src/shared/types';
import { checkRegexBrackets, explanationToMarkdown, formatHistoryQuery, friendlyRegexError, isValidBranchName, issueBranchSlug, languageFromPath, linkifyText, parseHistoryQuery, parseRemoteUrl, sanitizeBranchName, splitLines, joinLines } from '../src/shared/util';

describe('util', () => {
  it('parses GitHub remote URLs', () => {
    expect(parseRemoteUrl('https://github.com/erwin-wee/gitgood.git')).toEqual({ host: 'github.com', owner: 'erwin-wee', name: 'gitgood', url: 'https://github.com/erwin-wee/gitgood' });
    expect(parseRemoteUrl('git@github.com:erwin-wee/gitgood.git')?.owner).toBe('erwin-wee');
    expect(parseRemoteUrl('ssh://git@github.com/erwin-wee/gitgood')?.name).toBe('gitgood');
    expect(parseRemoteUrl('https://ghe.example.com/org/repo')?.host).toBe('ghe.example.com');
    expect(parseRemoteUrl('not a url')).toBeNull();
  });

  it('detects languages', () => {
    expect(languageFromPath('src/a.tsx')).toBe('typescript');
    expect(languageFromPath('Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('dir/Makefile')).toBe('makefile');
    expect(languageFromPath('x.unknownext')).toBeNull();
  });

  it('validates and sanitizes branch names', () => {
    expect(isValidBranchName('feature/foo-bar')).toBe(true);
    expect(isValidBranchName('bad name')).toBe(false);
    expect(isValidBranchName('a..b')).toBe(false);
    expect(isValidBranchName('-lead')).toBe(false);
    expect(sanitizeBranchName('My New Feature!')).toBe('My-New-Feature!');
    expect(isValidBranchName(sanitizeBranchName('has space and ~ tilde'))).toBe(true);
  });

  it('splits and joins lines preserving endings', () => {
    const s = splitLines('a\r\nb\r\n');
    expect(s.lines).toEqual(['a', 'b']);
    expect(s.eol).toBe('\r\n');
    expect(joinLines(s.lines, s.eol, s.trailingNewline)).toBe('a\r\nb\r\n');
    expect(splitLines('').lines).toEqual([]);
    expect(splitLines('x').trailingNewline).toBe(false);
  });
});

describe('history search query syntax', () => {
  it('parses every prefix', () => {
    expect(parseHistoryQuery('content:needle').query.content).toBe('needle');
    expect(parseHistoryQuery('regex:^import').query.diffRegex).toBe('^import');
    expect(parseHistoryQuery('path:src/app.ts').query.paths).toEqual(['src/app.ts']);
    expect(parseHistoryQuery('author:erwin').query.author).toBe('erwin');
    expect(parseHistoryQuery('after:2026-01-01').query.after).toBe('2026-01-01');
    expect(parseHistoryQuery('before:2026-02-01').query.before).toBe('2026-02-01');
    expect(parseHistoryQuery('all:').query.allRefs).toBe(true);
  });

  it('supports quoted values with spaces and escaped quotes', () => {
    const { query } = parseHistoryQuery('path:"src/some file.ts" author:"Jane \\"JD\\" Doe"');
    expect(query.paths).toEqual(['src/some file.ts']);
    expect(query.author).toBe('Jane "JD" Doe');
  });

  it('treats unknown prefixes and plain words as free text', () => {
    const { query, freeText } = parseHistoryQuery('fixup wibble:foo bar');
    expect(query).toMatchObject({ content: null, diffRegex: null, author: null });
    expect(freeText).toBe('fixup wibble:foo bar');
  });

  it('combines structured filters with free text', () => {
    const { query, freeText } = parseHistoryQuery('author:erwin after:2026-01-01 path:src/** fix');
    expect(query.author).toBe('erwin');
    expect(query.after).toBe('2026-01-01');
    expect(query.paths).toEqual(['src/**']);
    expect(freeText).toBe('fix');
  });

  it('round-trips format -> parse', () => {
    const text = 'author:"Jane Doe" content:needle path:src/app.ts all:';
    const { query, freeText } = parseHistoryQuery(text);
    const formatted = formatHistoryQuery(query, freeText);
    const reparsed = parseHistoryQuery(formatted);
    expect(reparsed.query).toEqual(query);
    expect(reparsed.freeText).toBe(freeText);
  });

  it('flags unbalanced parentheses and brackets, ignoring escaped characters', () => {
    expect(checkRegexBrackets('^import')).toBeNull();
    expect(checkRegexBrackets('(foo|bar)')).toBeNull();
    expect(checkRegexBrackets('\\(literal')).toBeNull();
    expect(checkRegexBrackets('(')).toMatch(/parentheses/);
    expect(checkRegexBrackets('foo)')).toMatch(/parentheses/);
    expect(checkRegexBrackets('[a-z')).toMatch(/brackets/);
  });

  it('extracts a friendly one-line message from git regex-compile stderr', () => {
    expect(friendlyRegexError("fatal: invalid regex: Unmatched ( or \\(\n")).toBe('invalid regex: Unmatched ( or \\(');
    expect(friendlyRegexError('fatal: -G requires a stringn')).toBe('-G requires a stringn');
    expect(friendlyRegexError('')).toBe('Invalid regular expression.');
  });

  it('slugifies an issue title into a branch name capped at 60 characters with an N- prefix', () => {
    expect(issueBranchSlug(123, 'Fix login timeout')).toBe('123-fix-login-timeout');
    expect(issueBranchSlug(4, 'Weird!!  Punctuation... & Stuff???')).toBe('4-weird-punctuation-stuff');
    const long = issueBranchSlug(7, 'x'.repeat(100));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.startsWith('7-')).toBe(true);
    expect(long.endsWith('-')).toBe(false);
    expect(issueBranchSlug(1, '')).toBe('1-');
  });

  it('linkifies bare URLs without treating the rest of the text as markup', () => {
    expect(linkifyText('see https://example.com/x for details')).toEqual([
      { text: 'see ', url: null },
      { text: 'https://example.com/x', url: 'https://example.com/x' },
      { text: ' for details', url: null },
    ]);
    expect(linkifyText('<script>alert(1)</script> https://a.example.')).toEqual([
      { text: '<script>alert(1)</script> ', url: null },
      { text: 'https://a.example', url: 'https://a.example' },
      { text: '.', url: null },
    ]);
    expect(linkifyText('no links here')).toEqual([{ text: 'no links here', url: null }]);
  });
});

describe('explanationToMarkdown', () => {
  const explanation: Explanation = {
    whatChanged: 'Added a null check before the addition.',
    why: 'Likely to avoid a crash when a is missing.',
    impact: 'Callers passing a null a no longer crash.',
    watchOutFor: ['Confirm b is validated too'],
    references: [{ path: 'math.ts', line: 1, label: 'the new check' }],
    truncated: false,
    droppedReferences: 0,
    model: 'claude-opus-5',
  };

  it('includes the commit SHA and all four sections for a commit target', () => {
    const md = explanationToMarkdown(explanation, { kind: 'commit', sha: 'abc1234' });
    expect(md).toContain('**Commit:** `abc1234`');
    expect(md).toContain('## What changed\n\nAdded a null check before the addition.');
    expect(md).toContain('## Why (inferred)');
    expect(md).toContain('## Impact');
    expect(md).toContain('## Watch out for\n\n- Confirm b is validated too');
    expect(md).not.toContain('**File:**');
  });

  it('includes the file path (and the commit SHA when the source is a commit) for a file target', () => {
    const md = explanationToMarkdown(explanation, { kind: 'file', source: { kind: 'commit', sha: 'abc1234' }, path: 'math.ts' });
    expect(md).toContain('**Commit:** `abc1234`');
    expect(md).toContain('**File:** `math.ts`');
  });

  it('omits the commit line for a working-tree file target', () => {
    const md = explanationToMarkdown(explanation, { kind: 'file', source: { kind: 'working' }, path: 'math.ts' });
    expect(md).not.toContain('**Commit:**');
    expect(md).toContain('**File:** `math.ts`');
  });

  it('omits empty sections and notes truncation', () => {
    const partial: Explanation = { ...explanation, why: '', impact: '', watchOutFor: [], truncated: true };
    const md = explanationToMarkdown(partial, { kind: 'commit', sha: 'abc1234' });
    expect(md).not.toContain('## Why (inferred)');
    expect(md).not.toContain('## Impact');
    expect(md).not.toContain('## Watch out for');
    expect(md).toContain('truncated');
  });
});
