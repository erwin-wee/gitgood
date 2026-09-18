import { describe, expect, it } from 'vitest';
import {
  isLiteralSigningKeyForm,
  isSshPublicKeyLiteral,
  looksLikeUnsupportedSshKeygen,
  normalizeSshSigningKey,
  parseGpgSecretKeys,
  parseGpgStatus,
  parseOpenSshVersion,
  parseSshPublicKey,
  supportsSshSigning,
  toLiteralSigningKey,
} from '../src/main/git/signing';

describe('parseGpgSecretKeys', () => {
  it('parses sec/uid records into keys with id, label, email and expiry', () => {
    const out = [
      'sec:u:4096:1:AAAABBBBCCCCDDDD:1600000000:1700000000::u:::scESC:::+::::',
      'fpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:',
      'uid:u::::1600000000::HASH::Ann Example <ann@example.com>::::::::::0:',
      'sec:u:4096:1:1111222233334444:1600000000::::u:::scESC:::+::::',
      'uid:u::::1600000000::HASH::Bob <bob@example.com>::::::::::0:',
    ].join('\n');
    const keys = parseGpgSecretKeys(out);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ id: 'AAAABBBBCCCCDDDD', label: 'Ann Example <ann@example.com>', email: 'ann@example.com', kind: 'gpg' });
    expect(keys[0].expires).toBe(new Date(1700000000 * 1000).toISOString());
    expect(keys[1]).toMatchObject({ id: '1111222233334444', email: 'bob@example.com' });
    expect(keys[1].expires).toBeNull();
  });

  it('returns an empty list for empty output', () => {
    expect(parseGpgSecretKeys('')).toEqual([]);
  });

  it('handles a uid with non-ASCII characters', () => {
    const out = ['sec:u:4096:1:FEDCBA9876543210:1600000000::::u:::scESC:::+::::', 'uid:u::::1600000000::HASH::Zoë Müller <zoe@example.com>::::::::::0:'].join('\n');
    const keys = parseGpgSecretKeys(out);
    expect(keys[0]).toMatchObject({ label: 'Zoë Müller <zoe@example.com>', email: 'zoe@example.com' });
  });
});

describe('parseSshPublicKey', () => {
  it('parses a standard ed25519 public key with a comment', () => {
    const key = parseSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus user@example.com\n', '/home/u/.ssh/id_ed25519.pub');
    expect(key).toMatchObject({ id: '/home/u/.ssh/id_ed25519.pub', label: 'user@example.com', email: 'user@example.com', kind: 'ssh' });
  });

  it('returns null for content that is not an SSH public key', () => {
    expect(parseSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\n', '/x')).toBeNull();
    expect(parseSshPublicKey('', '/x')).toBeNull();
  });

  it('handles a key with no comment', () => {
    const key = parseSshPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB bogus\n', '/x.pub');
    expect(key?.email).toBeNull();
  });
});

describe('pasted SSH key literal form', () => {
  it('recognizes a pasted public key and converts it to the key:: form', () => {
    const pasted = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus';
    expect(isSshPublicKeyLiteral(pasted)).toBe(true);
    expect(toLiteralSigningKey(pasted)).toBe(`key::${pasted}`);
    expect(isLiteralSigningKeyForm(`key::${pasted}`)).toBe(true);
  });

  it('normalizes a pasted key but leaves a file path untouched', () => {
    const pasted = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus me@example.com';
    expect(normalizeSshSigningKey(pasted)).toBe(`key::${pasted}`);
    expect(normalizeSshSigningKey('/home/u/.ssh/id_ed25519.pub')).toBe('/home/u/.ssh/id_ed25519.pub');
    expect(normalizeSshSigningKey(`key::${pasted}`)).toBe(`key::${pasted}`);
  });
});

describe('gpg status-fd parsing', () => {
  it('detects a successful signature', () => {
    const status = parseGpgStatus('[GNUPG:] SIG_CREATED D 1 10 00 1700000000 ABCDEF\n');
    expect(status).toMatchObject({ signed: true, needsPassphrase: false, badPassphrase: false });
  });

  it('detects a required passphrase', () => {
    const status = parseGpgStatus('[GNUPG:] NEED_PASSPHRASE 0123 4567 1 0\n');
    expect(status.needsPassphrase).toBe(true);
    expect(status.signed).toBe(false);
  });

  it('detects a missing secret key', () => {
    const status = parseGpgStatus('[GNUPG:] INV_SGNR 9 0123456789ABCDEF\n');
    expect(status.noSecretKey).toBe(true);
  });
});

describe('OpenSSH version support', () => {
  it('parses OpenSSH_x.y from `ssh -V` style output', () => {
    expect(parseOpenSshVersion('OpenSSH_9.6p1, OpenSSL 3.0.2')).toEqual({ major: 9, minor: 6 });
    expect(parseOpenSshVersion('OpenSSH_10.5')).toEqual({ major: 10, minor: 5 });
    expect(parseOpenSshVersion('not openssh')).toBeNull();
  });

  it('requires 8.8 or newer for SSH commit signing', () => {
    expect(supportsSshSigning({ major: 8, minor: 8 })).toBe(true);
    expect(supportsSshSigning({ major: 9, minor: 0 })).toBe(true);
    expect(supportsSshSigning({ major: 8, minor: 7 })).toBe(false);
    expect(supportsSshSigning({ major: 7, minor: 9 })).toBe(false);
    expect(supportsSshSigning(null)).toBe(false);
  });

  it('recognizes an ssh-keygen too old to know the -Y sign verb', () => {
    expect(looksLikeUnsupportedSshKeygen('unknown option -- Y\nusage: ssh-keygen [options]')).toBe(true);
    expect(looksLikeUnsupportedSshKeygen('Load key "/x": No such file or directory')).toBe(false);
    expect(looksLikeUnsupportedSshKeygen('Enter passphrase for key')).toBe(false);
  });
});
