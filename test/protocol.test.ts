import { describe, expect, it } from 'vitest';
import { parseProtocolUrl, protocolUrlFromArgv } from '../src/main/protocol';

describe('parseProtocolUrl', () => {
  it('still parses openRepo links from GitHub and from gitgood://', () => {
    expect(parseProtocolUrl('x-github-client://openRepo/https://github.com/o/r?branch=dev&filepath=src%2Fa.ts')).toEqual({ kind: 'open-repo', url: 'https://github.com/o/r', branch: 'dev', filepath: 'src/a.ts' });
    expect(parseProtocolUrl('gitgood://openRepo/https://github.com/o/r/')).toEqual({ kind: 'open-repo', url: 'https://github.com/o/r', branch: null, filepath: null });
  });

  it('parses the re-review deep link with a percent-encoded path', () => {
    expect(parseProtocolUrl('gitgood://review/rerun?repo=%2Fhome%2Fdev%2Fmy%20app')).toEqual({ kind: 'review-rerun', repoPath: '/home/dev/my app' });
    expect(parseProtocolUrl(' GITGOOD://review/rerun/?repo=C%3A%5Cwork%5Capp \n')).toEqual({ kind: 'review-rerun', repoPath: 'C:\\work\\app' });
  });

  it('keeps a plus sign in the path instead of decoding it as a space', () => {
    // URLSearchParams would turn '+' into ' '; '+' is legal in a path everywhere.
    expect(parseProtocolUrl('gitgood://review/rerun?repo=%2Fsrc%2Fc%2B%2B%20app')).toEqual({ kind: 'review-rerun', repoPath: '/src/c++ app' });
    expect(parseProtocolUrl('gitgood://review/rerun?repo=/src/c+/x')).toEqual({ kind: 'review-rerun', repoPath: '/src/c+/x' });
  });

  it('ignores rerun links without a repo and unknown paths', () => {
    expect(parseProtocolUrl('gitgood://review/rerun?other=1')).toBeNull();
    expect(parseProtocolUrl('gitgood://review/rerun?repo=')).toBeNull();
    expect(parseProtocolUrl('gitgood://review/rerun')).toBeNull();
    expect(parseProtocolUrl('gitgood://review/start?repo=%2Fx')).toBeNull();
    expect(parseProtocolUrl('gitgood://review/rerun?repo=%ZZ')).toBeNull();
    expect(parseProtocolUrl('gitgood://openRepo/not a url')).toBeNull();
    expect(parseProtocolUrl('https://example.com')).toBeNull();
  });
});

describe('protocolUrlFromArgv', () => {
  it('finds the first protocol URL among the arguments', () => {
    expect(protocolUrlFromArgv(['electron', '--flag', 'gitgood://review/rerun?repo=%2Fr'])).toBe('gitgood://review/rerun?repo=%2Fr');
    expect(protocolUrlFromArgv(['electron', '/some/path'])).toBeNull();
  });
});
