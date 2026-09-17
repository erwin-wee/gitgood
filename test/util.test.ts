import { describe, expect, it } from 'vitest';
import { isValidBranchName, languageFromPath, parseRemoteUrl, sanitizeBranchName, splitLines, joinLines } from '../src/shared/util';

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
