import { describe, expect, it } from 'vitest';
import { parseGitmodulesConfig, parseSubmoduleStatus, resolveSubmoduleUrl } from '../src/main/git/submodules';

describe('parseSubmoduleStatus', () => {
  it('parses an up-to-date submodule with a describe suffix', () => {
    const out = ' c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70 lib (heads/main)\n';
    expect(parseSubmoduleStatus(out)).toEqual([{ prefix: ' ', sha: 'c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70', path: 'lib', describe: 'heads/main' }]);
  });

  it('parses an uninitialized submodule (no describe suffix)', () => {
    const out = '-c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70 lib\n';
    expect(parseSubmoduleStatus(out)).toEqual([{ prefix: '-', sha: 'c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70', path: 'lib', describe: null }]);
  });

  it('parses a submodule that differs from the recorded commit', () => {
    const out = '+c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70 lib (heads/feature)\n';
    expect(parseSubmoduleStatus(out)).toEqual([{ prefix: '+', sha: 'c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70', path: 'lib', describe: 'heads/feature' }]);
  });

  it('parses a conflicted submodule', () => {
    const out = 'Uc1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70 lib\n';
    expect(parseSubmoduleStatus(out)).toEqual([{ prefix: 'U', sha: 'c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70', path: 'lib', describe: null }]);
  });

  it('parses multiple lines, including nested (recursive) paths', () => {
    const out = ' c1e9d520f1e2a3b4c5d6e7f8091a2b3c4d5e6f70 vendor/outer (heads/main)\n-a1b2c3d4e5f60718293a4b5c6d7e8f900112233 vendor/outer/inner\n';
    const parsed = parseSubmoduleStatus(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe('vendor/outer');
    expect(parsed[1]).toMatchObject({ prefix: '-', path: 'vendor/outer/inner' });
  });

  it('ignores blank lines', () => {
    expect(parseSubmoduleStatus('\n\n')).toEqual([]);
  });
});

describe('parseGitmodulesConfig', () => {
  it('parses path/url/branch entries for one submodule', () => {
    const out = ['submodule.lib.path\nlib', 'submodule.lib.url\nhttps://example.com/lib.git', 'submodule.lib.branch\nmain'].join('\0') + '\0';
    expect(parseGitmodulesConfig(out)).toEqual([{ name: 'lib', path: 'lib', url: 'https://example.com/lib.git', branch: 'main' }]);
  });

  it('parses multiple submodules and defaults branch to null', () => {
    const out = ['submodule.a.path\na', 'submodule.a.url\n../a.git', 'submodule.b.path\nb', 'submodule.b.url\n../b.git'].join('\0') + '\0';
    expect(parseGitmodulesConfig(out)).toEqual([
      { name: 'a', path: 'a', url: '../a.git', branch: null },
      { name: 'b', path: 'b', url: '../b.git', branch: null },
    ]);
  });

  it('returns an empty array for empty output', () => {
    expect(parseGitmodulesConfig('')).toEqual([]);
  });
});

describe('resolveSubmoduleUrl', () => {
  it('leaves absolute URLs unchanged', () => {
    expect(resolveSubmoduleUrl('https://example.com/lib.git', 'https://example.com/foo/bar.git')).toBe('https://example.com/lib.git');
  });

  it('resolves a "./" URL by appending under the full origin path, matching git\'s own resolve-relative-url (verified against a real `git submodule add ./x` against a local remote)', () => {
    expect(resolveSubmoduleUrl('./baz.git', 'https://github.com/foo/bar.git')).toBe('https://github.com/foo/bar.git/baz.git');
  });

  it('resolves a parent-relative URL (../), matching git\'s documented example', () => {
    expect(resolveSubmoduleUrl('../baz.git', 'https://github.com/foo/bar.git')).toBe('https://github.com/foo/baz.git');
  });

  it('resolves an SCP-like origin URL', () => {
    expect(resolveSubmoduleUrl('../baz.git', 'git@github.com:foo/bar.git')).toBe('git@github.com:foo/baz.git');
  });

  it('resolves multiple ".." segments', () => {
    expect(resolveSubmoduleUrl('../../other/baz.git', 'https://github.com/foo/nested/bar.git')).toBe('https://github.com/foo/other/baz.git');
  });

  it('returns the relative URL unchanged when there is no origin to resolve against', () => {
    expect(resolveSubmoduleUrl('../baz.git', null)).toBe('../baz.git');
  });
});
