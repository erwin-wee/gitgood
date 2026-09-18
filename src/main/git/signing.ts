import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SigningKey } from '@shared/types';
import { exec } from '../exec';

// ---------------------------------------------------------------------------
// GPG secret key listing (`gpg --list-secret-keys --with-colons --keyid-format=long`)
// ---------------------------------------------------------------------------

/**
 * Parses `gpg --list-secret-keys --with-colons --keyid-format=long` output.
 * Each key starts with a `sec:` record (long key id in field 4, expiry epoch
 * seconds in field 6) followed by one or more `uid:` records (field 9 is the
 * "Name <email>" user id string); the first uid is used as the label.
 */
export function parseGpgSecretKeys(output: string): SigningKey[] {
  const keys: SigningKey[] = [];
  let current: SigningKey | null = null;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(':');
    if (f[0] === 'sec') {
      if (current) keys.push(current);
      const id = f[4] ?? '';
      const expiresEpoch = f[6] ? parseInt(f[6], 10) : NaN;
      current = { id, label: id, email: null, expires: Number.isFinite(expiresEpoch) && expiresEpoch > 0 ? new Date(expiresEpoch * 1000).toISOString() : null, kind: 'gpg' };
    } else if (f[0] === 'uid' && current && !current.email) {
      const uid = (f[9] ?? '').trim();
      const m = /^(.*?)\s*<([^>]+)>$/.exec(uid);
      current.label = uid || current.id;
      current.email = m ? m[2] : null;
    }
  }
  if (current) keys.push(current);
  return keys;
}

export async function listGpgSecretKeys(gpgPath: string, env: NodeJS.ProcessEnv): Promise<SigningKey[]> {
  const result = await exec(gpgPath, ['--batch', '--list-secret-keys', '--with-colons', '--keyid-format=long'], { env, timeoutMs: 15000 });
  return parseGpgSecretKeys(result.stdout);
}

/** True when `keyId` (with or without a leading 0x, short or long form) matches a secret key gpg already knows about. */
export async function gpgKeyExists(gpgPath: string, env: NodeJS.ProcessEnv, keyId: string): Promise<boolean> {
  const keys = await listGpgSecretKeys(gpgPath, env);
  const normalized = keyId.replace(/^0x/i, '').toUpperCase();
  return keys.some((k) => k.id.toUpperCase() === normalized || k.id.toUpperCase().endsWith(normalized));
}

// ---------------------------------------------------------------------------
// SSH public key discovery
// ---------------------------------------------------------------------------

/** Parses one `.pub` file's first line into a SigningKey; null when it does not look like an SSH public key. */
export function parseSshPublicKey(content: string, path: string): SigningKey | null {
  const line = content.trim().split('\n')[0]?.trim();
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 2 || !/^(ssh-|ecdsa-sha2-|sk-)/.test(parts[0])) return null;
  const comment = parts.slice(2).join(' ');
  const email = comment.includes('@') ? comment : null;
  return { id: path, label: comment || path, email, expires: null, kind: 'ssh' };
}

export async function listSshPublicKeys(sshDir: string): Promise<SigningKey[]> {
  let entries: string[];
  try {
    entries = await readdir(sshDir);
  } catch {
    return [];
  }
  const keys: SigningKey[] = [];
  for (const name of entries.filter((n) => n.endsWith('.pub'))) {
    try {
      const content = await readFile(join(sshDir, name), 'utf8');
      const key = parseSshPublicKey(content, join(sshDir, name));
      if (key) keys.push(key);
    } catch {
      /* unreadable; skip */
    }
  }
  return keys;
}

export async function sshKeyFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pasted SSH public keys: git recognises `key::<literal public key>` as a signing key.
// ---------------------------------------------------------------------------

export function isSshPublicKeyLiteral(text: string): boolean {
  return /^(ssh-|ecdsa-sha2-|sk-)\S+\s+[A-Za-z0-9+/=]+/.test(text.trim());
}

export function isLiteralSigningKeyForm(key: string): boolean {
  return key.startsWith('key::');
}

export function toLiteralSigningKey(pubkey: string): string {
  return `key::${pubkey.trim()}`;
}

/** Normalizes a raw SSH key field value from the UI: a pasted public key becomes the `key::` literal form; a file path is left as-is. */
export function normalizeSshSigningKey(raw: string): string {
  const trimmed = raw.trim();
  if (isLiteralSigningKeyForm(trimmed) || !isSshPublicKeyLiteral(trimmed)) return trimmed;
  return toLiteralSigningKey(trimmed);
}

// ---------------------------------------------------------------------------
// GPG status-fd parsing (Test signing)
// ---------------------------------------------------------------------------

export interface GpgStatus {
  needsPassphrase: boolean;
  badPassphrase: boolean;
  signed: boolean;
  noSecretKey: boolean;
}

/** Parses `--status-fd=2` GnuPG status lines (`[GNUPG:] TOKEN ...`). */
export function parseGpgStatus(output: string): GpgStatus {
  const lines = output.split('\n');
  const has = (token: string) => lines.some((l) => l.includes(`[GNUPG:] ${token}`) || l.includes(token));
  return {
    needsPassphrase: has('NEED_PASSPHRASE') || has('USERID_HINT'),
    badPassphrase: has('BAD_PASSPHRASE') || has('MISSING_PASSPHRASE'),
    signed: has('SIG_CREATED'),
    noSecretKey: has('NO_SECKEY') || has('INV_SGNR'),
  };
}

// ---------------------------------------------------------------------------
// OpenSSH version check (SSH signing needs OpenSSH 8.8+)
// ---------------------------------------------------------------------------

export function parseOpenSshVersion(output: string): { major: number; minor: number } | null {
  const m = /OpenSSH_(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

export function supportsSshSigning(version: { major: number; minor: number } | null): boolean {
  if (!version) return false;
  return version.major > 8 || (version.major === 8 && version.minor >= 8);
}

/** True when ssh-keygen's own error output indicates it does not know the `-Y sign` verb at all (too old). */
export function looksLikeUnsupportedSshKeygen(stderr: string): boolean {
  return /unknown option|usage: ssh-keygen/i.test(stderr) && !/passphrase|permission denied|no such file/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Test signing: produces a real signature outside git, so a distinct result
// (success / passphrase required / program missing / key missing) can be
// reported without ever touching a passphrase ourselves.
// ---------------------------------------------------------------------------

export interface SigningTestResult {
  ok: boolean;
  message: string;
  needsPassphrase: boolean;
}

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'gitgood-signtest-'));
  const file = join(dir, 'test.txt');
  await writeFile(file, 'GitGood signing test\n', 'utf8');
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function testGpgSigning(gpgPath: string, keyId: string, env: NodeJS.ProcessEnv): Promise<SigningTestResult> {
  return withTempFile(async (file) => {
    try {
      const result = await exec(gpgPath, ['--batch', '--status-fd=2', '--local-user', keyId, '--detach-sign', '-o', `${file}.sig`, file], { env, timeoutMs: 15000 });
      const status = parseGpgStatus(result.stderr);
      if (status.signed) return { ok: true, message: 'GPG can sign with this key.', needsPassphrase: false };
      return { ok: false, message: 'GPG did not report a completed signature.', needsPassphrase: status.needsPassphrase };
    } catch (err) {
      const stderr = (err as { result?: { stderr: string } }).result?.stderr ?? (err instanceof Error ? err.message : String(err));
      const status = parseGpgStatus(stderr);
      if (status.noSecretKey) return { ok: false, message: `No secret key ${keyId} is available to GPG.`, needsPassphrase: false };
      if (status.needsPassphrase || status.badPassphrase) {
        return { ok: false, message: 'A passphrase is required and no agent has it cached. GitGood cannot show terminal prompts, so a graphical pinentry or a running gpg-agent with the passphrase already unlocked is needed.', needsPassphrase: true };
      }
      return { ok: false, message: stderr.trim().split('\n')[0] || 'GPG could not sign the test file.', needsPassphrase: false };
    }
  });
}

export async function testSshSigning(sshKeygenPath: string, keyPath: string, env: NodeJS.ProcessEnv): Promise<SigningTestResult> {
  return withTempFile(async (file) => {
    try {
      await exec(sshKeygenPath, ['-Y', 'sign', '-n', 'git', '-f', keyPath, file], { env, timeoutMs: 15000 });
      return { ok: true, message: 'ssh-keygen can sign with this key.', needsPassphrase: false };
    } catch (err) {
      const stderr = (err as { result?: { stderr: string } }).result?.stderr ?? (err instanceof Error ? err.message : String(err));
      if (looksLikeUnsupportedSshKeygen(stderr)) return { ok: false, message: 'This OpenSSH version is too old for SSH commit signing (need 8.8+).', needsPassphrase: false };
      if (/no such file|cannot open|permission denied/i.test(stderr) && !/passphrase/i.test(stderr)) return { ok: false, message: `The SSH key "${keyPath}" could not be read.`, needsPassphrase: false };
      if (/passphrase|incorrect passphrase|bad passphrase/i.test(stderr)) {
        return { ok: false, message: 'This SSH key is passphrase-protected and no agent has it unlocked. GitGood cannot show terminal prompts, so load the key into ssh-agent first.', needsPassphrase: true };
      }
      return { ok: false, message: stderr.trim().split('\n')[0] || 'ssh-keygen could not sign the test file.', needsPassphrase: false };
    }
  });
}
