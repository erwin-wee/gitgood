import { describe, expect, it } from 'vitest';
import { testGpgSigning, testSshSigning } from '../../src/main/git/signing';
import { createStubScenario, gpgLauncherPath, sshKeygenLauncherPath } from '../helpers/gh-stub';

describe('testGpgSigning (stubbed gpg)', () => {
  it('reports success when gpg reports SIG_CREATED', async () => {
    const scenario = await createStubScenario([{ match: '--detach-sign', stderr: '[GNUPG:] SIG_CREATED D 1 10 00 1700000000 ABCDEF\n', exitCode: 0 }]);
    try {
      const result = await testGpgSigning(gpgLauncherPath(), 'ABCDEF0123456789', { ...process.env, ...scenario.env('GPG') });
      expect(result).toMatchObject({ ok: true, needsPassphrase: false });
    } finally {
      await scenario.dispose();
    }
  });

  it('reports "passphrase required" when gpg needs one and no agent has it', async () => {
    const scenario = await createStubScenario([{ match: '--detach-sign', stderr: '[GNUPG:] NEED_PASSPHRASE 0123 4567 1 0\n[GNUPG:] MISSING_PASSPHRASE\n', exitCode: 2 }]);
    try {
      const result = await testGpgSigning(gpgLauncherPath(), 'ABCDEF0123456789', { ...process.env, ...scenario.env('GPG') });
      expect(result).toMatchObject({ ok: false, needsPassphrase: true });
    } finally {
      await scenario.dispose();
    }
  });

  it('reports a missing secret key distinctly', async () => {
    const scenario = await createStubScenario([{ match: '--detach-sign', stderr: '[GNUPG:] INV_SGNR 9 ABCDEF0123456789\ngpg: signing failed: No secret key\n', exitCode: 2 }]);
    try {
      const result = await testGpgSigning(gpgLauncherPath(), 'ABCDEF0123456789', { ...process.env, ...scenario.env('GPG') });
      expect(result.ok).toBe(false);
      expect(result.needsPassphrase).toBe(false);
      expect(result.message).toContain('No secret key');
    } finally {
      await scenario.dispose();
    }
  });
});

describe('testSshSigning (stubbed ssh-keygen)', () => {
  it('reports success on exit 0', async () => {
    const scenario = await createStubScenario([{ match: ['-Y', 'sign'], exitCode: 0 }]);
    try {
      const result = await testSshSigning(sshKeygenLauncherPath(), '/home/u/.ssh/id_ed25519', { ...process.env, ...scenario.env('SSH_KEYGEN') });
      expect(result).toMatchObject({ ok: true, needsPassphrase: false });
    } finally {
      await scenario.dispose();
    }
  });

  it('reports "passphrase required" for a locked key with no agent', async () => {
    const scenario = await createStubScenario([{ match: ['-Y', 'sign'], stderr: 'sign_and_send_pubkey: incorrect passphrase supplied to decrypt private key\n', exitCode: 255 }]);
    try {
      const result = await testSshSigning(sshKeygenLauncherPath(), '/home/u/.ssh/id_ed25519', { ...process.env, ...scenario.env('SSH_KEYGEN') });
      expect(result).toMatchObject({ ok: false, needsPassphrase: true });
    } finally {
      await scenario.dispose();
    }
  });

  it('reports a missing program result when ssh-keygen is too old for -Y sign', async () => {
    const scenario = await createStubScenario([{ match: ['-Y', 'sign'], stderr: 'unknown option -- Y\nusage: ssh-keygen [options]\n', exitCode: 255 }]);
    try {
      const result = await testSshSigning(sshKeygenLauncherPath(), '/home/u/.ssh/id_ed25519', { ...process.env, ...scenario.env('SSH_KEYGEN') });
      expect(result.ok).toBe(false);
      expect(result.needsPassphrase).toBe(false);
      expect(result.message).toMatch(/too old/i);
    } finally {
      await scenario.dispose();
    }
  });

  it('reports a missing key file distinctly', async () => {
    const scenario = await createStubScenario([{ match: ['-Y', 'sign'], stderr: 'Load key "/home/u/.ssh/missing": No such file or directory\n', exitCode: 255 }]);
    try {
      const result = await testSshSigning(sshKeygenLauncherPath(), '/home/u/.ssh/missing', { ...process.env, ...scenario.env('SSH_KEYGEN') });
      expect(result.ok).toBe(false);
      expect(result.needsPassphrase).toBe(false);
      expect(result.message).toContain('could not be read');
    } finally {
      await scenario.dispose();
    }
  });
});
