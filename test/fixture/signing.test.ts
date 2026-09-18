import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommit } from '../../src/main/git/commit';
import { GitClient } from '../../src/main/git/git';
import { getHistory } from '../../src/main/git/log';
import { getSigningConfig, setSigningConfig } from '../../src/main/git/operations';
import { parseGpgSecretKeys } from '../../src/main/git/signing';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

function hasGpgSync(): boolean {
  try {
    execFileSync('gpg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasSshKeygenSync(): boolean {
  try {
    execFileSync('ssh-keygen', ['-V'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // ssh-keygen has no -V flag; it exits non-zero but that still proves it exists.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

describe.skipIf(!hasGitSync())('signing config read/write', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('round-trips local signing config without touching global', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await setSigningConfig(git, repo.path, 'local', { format: 'openpgp', key: 'ABCDEF0123456789', signCommits: true, signTags: false });
    const info = await getSigningConfig(git, repo.path);
    expect(info.local).toMatchObject({ format: 'openpgp', key: 'ABCDEF0123456789', signCommits: true, signTags: false, scope: 'local' });
    expect(info.global).toMatchObject({ format: null, key: null, scope: 'none' });
    expect(info.effective).toMatchObject({ format: 'openpgp', key: 'ABCDEF0123456789', signCommits: true });
  });

  it('turning signing off only touches signCommits/signTags, keeping the key and format', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    await setSigningConfig(git, repo.path, 'local', { format: 'ssh', key: '/home/u/.ssh/id_ed25519.pub', signCommits: true, signTags: true });
    await setSigningConfig(git, repo.path, 'local', { signCommits: false, signTags: false });
    const info = await getSigningConfig(git, repo.path);
    expect(info.local).toMatchObject({ format: 'ssh', key: '/home/u/.ssh/id_ed25519.pub', signCommits: false, signTags: false });
  });

  it('writes global scope without creating any local config', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const git = new GitClient(repo.tools());
    // createRepo sets commit.gpgsign/tag.gpgsign=false locally as a safety net for unrelated
    // tests; unset those here so this test can show a clean global write taking effect.
    await git.tryRun(repo.path, ['config', '--local', '--unset', 'commit.gpgsign']);
    await git.tryRun(repo.path, ['config', '--local', '--unset', 'tag.gpgsign']);
    await setSigningConfig(git, null, 'global', { format: 'openpgp', key: 'FEDCBA9876543210', signCommits: true });
    const info = await getSigningConfig(git, repo.path);
    expect(info.global).toMatchObject({ format: 'openpgp', key: 'FEDCBA9876543210', signCommits: true, scope: 'global' });
    expect(info.local).toMatchObject({ format: null, key: null, scope: 'none' });
    expect(info.effective).toMatchObject({ format: 'openpgp', key: 'FEDCBA9876543210', signCommits: true, scope: 'global' });
  });
});

describe.skipIf(!hasGitSync() || !hasGpgSync())('real GPG signing', () => {
  let repo: TestRepo | undefined;
  let gpgEnv: NodeJS.ProcessEnv | undefined;

  afterEach(async () => {
    if (gpgEnv) {
      try {
        execFileSync('gpgconf', ['--kill', 'gpg-agent'], { env: gpgEnv, stdio: 'ignore' });
      } catch {
        /* best-effort cleanup */
      }
      gpgEnv = undefined;
    }
    await repo?.dispose();
    repo = undefined;
  });

  it('signs a commit with a throwaway empty-passphrase key and verifies %G? as good', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const gnupgHome = join(repo.root, 'gnupghome');
    await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
    gpgEnv = { ...repo.env, GNUPGHOME: gnupgHome };
    delete gpgEnv.GPG_TTY;

    execFileSync('gpg', ['--batch', '--passphrase', '', '--pinentry-mode', 'loopback', '--quick-gen-key', 'GitGood Test <gitgood-test@example.com>', 'default', 'default', 'never'], { env: gpgEnv, stdio: 'pipe' });
    const listOut = execFileSync('gpg', ['--batch', '--list-secret-keys', '--with-colons', '--keyid-format=long'], { env: gpgEnv }).toString('utf8');
    const keys = parseGpgSecretKeys(listOut);
    expect(keys.length).toBeGreaterThan(0);
    const keyId = keys[0].id;

    const git = new GitClient(repo.tools({ env: gpgEnv }));
    await setSigningConfig(git, repo.path, 'local', { format: 'openpgp', key: keyId, signCommits: true, signTags: false });

    await repo.write('b.txt', '2\n');
    const sha = await createCommit(git, repo.path, { summary: 'Signed commit', description: '', coAuthors: [], amend: false, files: ['b.txt'], partialPatches: {} }, false);

    const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 5, path: null, search: null, follow: false, verifySignatures: true });
    const commit = page.commits.find((c) => c.sha === sha);
    expect(commit).toBeDefined();
    expect(commit!.signature).toMatchObject({ status: 'good', keyId });
  }, 30000);
});

describe.skipIf(!hasGitSync() || !hasSshKeygenSync())('real SSH signing', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('signs a commit with an ed25519 key and verifies %G? as good via an allowed-signers file', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const keyPath = join(repo.root, 'id_ed25519');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'gitgood-test@example.com'], { env: repo.env, stdio: 'pipe' });
    const pubkey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
    const allowedSigners = join(repo.root, 'allowed_signers');
    await writeFile(allowedSigners, `gitgood-test@example.com ${pubkey}\n`, 'utf8');

    const git = new GitClient(repo.tools());
    await setSigningConfig(git, repo.path, 'local', { format: 'ssh', key: `${keyPath}.pub`, signCommits: true, signTags: false, allowedSignersFile: allowedSigners });
    await git.run(repo.path, ['config', 'user.email', 'gitgood-test@example.com']);

    await repo.write('c.txt', '3\n');
    const sha = await createCommit(git, repo.path, { summary: 'SSH-signed commit', description: '', coAuthors: [], amend: false, files: ['c.txt'], partialPatches: {} }, false);

    const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 5, path: null, search: null, follow: false, verifySignatures: true });
    const commit = page.commits.find((c) => c.sha === sha);
    expect(commit).toBeDefined();
    expect(commit!.signature?.status).toBe('good');
  }, 30000);

  it('reports no signature status at all when no allowed-signers file is configured (a git limitation, not just an app choice)', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const keyPath = join(repo.root, 'id_ed25519_unverified');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'gitgood-test@example.com'], { env: repo.env, stdio: 'pipe' });

    const git = new GitClient(repo.tools());
    // Deliberately no allowedSignersFile: without one, `git log --format=%G?` cannot attempt SSH
    // verification at all and reports 'N' (no different from an unsigned commit) rather than an
    // "unknown key" code — hence the tooltip on the settings page explaining the file is needed.
    await setSigningConfig(git, repo.path, 'local', { format: 'ssh', key: `${keyPath}.pub`, signCommits: true, signTags: false });
    await git.run(repo.path, ['config', 'user.email', 'gitgood-test@example.com']);

    await repo.write('d.txt', '4\n');
    const sha = await createCommit(git, repo.path, { summary: 'Unverifiable SSH-signed commit', description: '', coAuthors: [], amend: false, files: ['d.txt'], partialPatches: {} }, false);

    const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 5, path: null, search: null, follow: false, verifySignatures: true });
    const commit = page.commits.find((c) => c.sha === sha);
    expect(commit).toBeDefined();
    expect(commit!.signature?.status).toBe('none');
  }, 30000);

  it('shows an untrusted/unknown-signer status when an allowed-signers file exists but does not list this signer', async () => {
    repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': '1\n' } }] });
    const keyPath = join(repo.root, 'id_ed25519_other');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'gitgood-test@example.com'], { env: repo.env, stdio: 'pipe' });
    const otherKeyPath = join(repo.root, 'id_ed25519_not_this_one');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', otherKeyPath, '-C', 'someone-else@example.com'], { env: repo.env, stdio: 'pipe' });
    const pubkey = readFileSync(`${otherKeyPath}.pub`, 'utf8').trim();
    const allowedSigners = join(repo.root, 'allowed_signers_wrong');
    await writeFile(allowedSigners, `someone-else@example.com ${pubkey}\n`, 'utf8');

    const git = new GitClient(repo.tools());
    await setSigningConfig(git, repo.path, 'local', { format: 'ssh', key: `${keyPath}.pub`, signCommits: true, signTags: false, allowedSignersFile: allowedSigners });
    await git.run(repo.path, ['config', 'user.email', 'gitgood-test@example.com']);

    await repo.write('e.txt', '5\n');
    const sha = await createCommit(git, repo.path, { summary: 'SSH-signed by an unlisted key', description: '', coAuthors: [], amend: false, files: ['e.txt'], partialPatches: {} }, false);

    const page = await getHistory(git, repo.path, { ref: null, skip: 0, limit: 5, path: null, search: null, follow: false, verifySignatures: true });
    const commit = page.commits.find((c) => c.sha === sha);
    expect(commit).toBeDefined();
    expect(commit!.signature?.status).toBe('untrusted');
  }, 30000);
});
