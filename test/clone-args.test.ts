import { describe, expect, it } from 'vitest';
import { cloneArgs, normalizeSparseDirs } from '../src/main/git/operations';

const base = { branch: null };

describe('cloneArgs', () => {
  it('keeps submodules on by default, matching the previous behaviour', () => {
    expect(cloneArgs('u', 'd', base)).toEqual(['clone', '--progress', '--recurse-submodules', '--', 'u', 'd']);
    expect(cloneArgs('u', 'd', { ...base, submodules: false })).toEqual(['clone', '--progress', '--', 'u', 'd']);
  });

  it('builds a shallow, blobless, sparse clone and shallows submodules too', () => {
    expect(cloneArgs('u', 'd', { branch: 'dev', depth: 1, blobless: true, sparse: ['src'] })).toEqual([
      'clone', '--progress', '--recurse-submodules', '--branch', 'dev', '--depth', '1', '--shallow-submodules', '--filter=blob:none', '--sparse', '--', 'u', 'd',
    ]);
  });

  it('adds --single-branch only when asked and rejects a bad depth or option-like branch', () => {
    expect(cloneArgs('u', 'd', { ...base, singleBranch: true, submodules: false })).toContain('--single-branch');
    expect(() => cloneArgs('u', 'd', { ...base, depth: 0 })).toThrow(/depth/);
    expect(() => cloneArgs('u', 'd', { ...base, depth: 1.5 })).toThrow(/depth/);
    expect(() => cloneArgs('u', 'd', { branch: '--upload-pack=x' })).toThrow(/must not start/);
  });
});

describe('normalizeSparseDirs', () => {
  it('normalizes separators, strips ./ and trailing slashes, and de-duplicates', () => {
    expect(normalizeSparseDirs([' ./src/ ', 'docs\\guides', '/src', ''])).toEqual(['src', 'docs/guides']);
  });

  it('refuses option-like and escaping entries', () => {
    expect(() => normalizeSparseDirs(['--foo'])).toThrow(/not a valid/);
    expect(() => normalizeSparseDirs(['a/../../b'])).toThrow(/not a valid/);
  });
});
