import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isEntryUrl, isTrustedSender } from '../src/main/app-url';
import { checkoutBranch, createBranch, deleteRemoteBranch, renameBranch } from '../src/main/git/branches';
import { fetch, isAncestor, merge, rebase, rebaseBaseFor } from '../src/main/git/operations';
import type { GitClient } from '../src/main/git/git';

describe('app frame trust', () => {
  const entry = pathToFileURL('/opt/GitGood/resources/app/out/renderer/index.html').href;

  it('accepts the entry document (query/hash ignored) and rejects any other file:// URL', () => {
    expect(isEntryUrl(entry, entry)).toBe(true);
    expect(isEntryUrl(`${entry}#/repo`, entry)).toBe(true);
    expect(isEntryUrl(pathToFileURL('/tmp/evil.html').href, entry)).toBe(false);
    expect(isEntryUrl(pathToFileURL('/opt/GitGood/resources/app/out/renderer/other.html').href, entry)).toBe(false);
    expect(isEntryUrl('https://example.com/', entry)).toBe(false);
    expect(isEntryUrl('', entry)).toBe(false);
    expect(isEntryUrl('not a url', entry)).toBe(false);
  });

  it('compares http entries by origin and path, not by prefix', () => {
    expect(isEntryUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isEntryUrl('http://localhost:5173/x', 'http://localhost:5173')).toBe(false);
    expect(isEntryUrl('http://localhost:5173.evil.test/', 'http://localhost:5173')).toBe(false);
    expect(isEntryUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
  });

  it('serves IPC only to the top-level frame showing the entry document', () => {
    const main = { url: entry };
    expect(isTrustedSender({ sender: { mainFrame: main }, senderFrame: main }, entry)).toBe(true);
    expect(isTrustedSender({ sender: { mainFrame: main }, senderFrame: { url: entry } }, entry)).toBe(false); // subframe
    expect(isTrustedSender({ sender: { mainFrame: main }, senderFrame: null }, entry)).toBe(false);
    const other = { url: pathToFileURL('/tmp/evil.html').href };
    expect(isTrustedSender({ sender: { mainFrame: other }, senderFrame: other }, entry)).toBe(false);
  });
});

describe('ref arguments starting with "-" are refused before git runs', () => {
  const fake = () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0) }));
    const git = { run, tryRun: run, stdout: vi.fn(async () => '') } as unknown as GitClient;
    return { git, run };
  };

  it('rejects option-like names in branch and operation functions', async () => {
    const { git, run } = fake();
    await expect(checkoutBranch(git, '/r', '--orphan')).rejects.toThrow(/must not start with "-"/);
    await expect(deleteRemoteBranch(git, '/r', '--mirror', 'x')).rejects.toThrow();
    await expect(createBranch(git, '/r', '-x', null, true)).rejects.toThrow();
    await expect(createBranch(git, '/r', 'ok', '--detach', true)).rejects.toThrow();
    await expect(renameBranch(git, '/r', 'a', '-m')).rejects.toThrow();
    await expect(merge(git, '/r', '--abort', false)).rejects.toThrow();
    await expect(rebase(git, '/r', '--exec=x')).rejects.toThrow();
    await expect(fetch(git, '/r', '--upload-pack=x', () => undefined)).rejects.toThrow();
    await expect(isAncestor(git, '/r', '-x', 'HEAD')).rejects.toThrow();
    await expect(rebaseBaseFor(git, '/r', ['abc1234', '-x'])).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('still runs ordinary names, and checkout gets no "--" separator', async () => {
    const { git, run } = fake();
    await checkoutBranch(git, '/r', 'feature/x');
    expect(run).toHaveBeenCalledWith('/r', ['checkout', 'feature/x']);
    await createBranch(git, '/r', 'topic', 'main', false);
    expect(run).toHaveBeenCalledWith('/r', ['branch', 'topic', 'main']);
  });
});
