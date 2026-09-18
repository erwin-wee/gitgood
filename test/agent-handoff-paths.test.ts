import { describe, expect, it } from 'vitest';
import { pathsEqual } from '../src/shared/util';

/** Used by the gitgood://review/rerun deep link to match its repo argument against the repository list. */
describe('pathsEqual', () => {
  it('matches regardless of separators and trailing slashes', () => {
    expect(pathsEqual('/home/dev/app', '/home/dev/app/', false)).toBe(true);
    expect(pathsEqual('C:\\work\\app', 'C:/work/app', true)).toBe(true);
    expect(pathsEqual('/home/dev/app', '/home/dev/other', false)).toBe(false);
  });

  it('ignores case only where the file system does', () => {
    expect(pathsEqual('C:\\Work\\App', 'c:/work/app', true)).toBe(true);
    expect(pathsEqual('/Users/Dev/App', '/users/dev/app', true)).toBe(true);
    // Linux paths are case-sensitive, so two differently-cased repositories stay distinct.
    expect(pathsEqual('/home/dev/App', '/home/dev/app', false)).toBe(false);
  });
});
