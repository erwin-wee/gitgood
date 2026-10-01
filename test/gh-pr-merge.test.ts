import { describe, expect, it } from 'vitest';
import { prMergeArgs, toPullRequest } from '../src/main/gh/gh';

describe('prMergeArgs', () => {
  it('merges immediately by default', () => {
    expect(prMergeArgs('o/r', 7, { method: 'squash', deleteBranch: false, auto: false })).toEqual(['pr', 'merge', '7', '--repo', 'o/r', '--squash']);
  });

  it('enables auto-merge with the chosen method and branch deletion', () => {
    expect(prMergeArgs('o/r', 7, { method: 'rebase', deleteBranch: true, auto: true })).toEqual(['pr', 'merge', '7', '--repo', 'o/r', '--rebase', '--auto', '--delete-branch']);
  });

  it('disables auto-merge without a method', () => {
    expect(prMergeArgs('o/r', 7, 'disable-auto')).toEqual(['pr', 'merge', '7', '--repo', 'o/r', '--disable-auto']);
  });
});

describe('toPullRequest autoMerge', () => {
  const raw = { number: 1, title: 't', url: 'u', headRefName: 'h', baseRefName: 'b', state: 'OPEN' as const, createdAt: '', updatedAt: '' };

  it('maps gh autoMergeRequest and degrades to null when absent', () => {
    expect(toPullRequest(raw).autoMerge).toBeNull();
    expect(toPullRequest({ ...raw, autoMergeRequest: { mergeMethod: 'SQUASH', enabledBy: { login: 'octo' } } }).autoMerge).toEqual({ method: 'squash', enabledBy: 'octo' });
    expect(toPullRequest({ ...raw, autoMergeRequest: { mergeMethod: 'WEIRD' } }).autoMerge).toEqual({ method: null, enabledBy: null });
  });
});
