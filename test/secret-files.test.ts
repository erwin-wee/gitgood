import { describe, expect, it } from 'vitest';
import { withScrubbing, type AiBackend, type AiRequest } from '../src/main/ai/backends';
import { skipReason } from '../src/main/ai/review-core';
import { dropSecretFilePatches, scrubSecrets, secretFileReason } from '../src/shared/secrets';
import type { CommitFile, DiffHunk } from '../src/shared/types';

const file = (path: string, over: Partial<CommitFile> = {}): CommitFile => ({ path, oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, lfs: false, ...over });
const hunk = (...lines: string[]): DiffHunk => ({ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: lines.map((text) => ({ type: 'add' as const, text, oldNumber: null, newNumber: 1 })) }) as DiffHunk;

describe('secretFileReason', () => {
  it.each(['.env', 'apps/web/.env.local', 'config/.ENV.production', 'server.pem', 'keys/tls.key', 'cert.p12', 'cert.pfx', 'home/id_rsa', 'id_ed25519', '.netrc', 'credentials.json', 'gcp/credentials-prod.json'])('flags %s', (p) => {
    expect(secretFileReason(p)).not.toBeNull();
  });

  it.each(['.env.example', '.env.sample', 'src/environment.ts', 'id_rsa.pub', 'README.md', 'src/keyboard.ts', 'credentials.ts', 'package.json'])('lets %s through', (p) => {
    expect(secretFileReason(p)).toBeNull();
  });

  it('flags .npmrc / .pypirc only when they carry credentials (and when that is unknown)', () => {
    expect(secretFileReason('.npmrc')).not.toBeNull();
    expect(secretFileReason('.npmrc', 'registry=https://registry.npmjs.org/\n')).toBeNull();
    expect(secretFileReason('web/.npmrc', '//registry.npmjs.org/:_authToken=abc123')).not.toBeNull();
    expect(secretFileReason('.pypirc', '[pypi]\npassword = hunter2')).not.toBeNull();
  });
});

describe('review skip rules', () => {
  it('skips secret-shaped files with a visible reason, even deleted ones', () => {
    expect(skipReason(file('.env'), 3)).toMatch(/never sent to AI/);
    expect(skipReason(file('deploy/key.pem', { status: 'deleted' }), 3)).toMatch(/private key/);
    expect(skipReason(file('src/app.ts'), 3)).toBeNull();
  });

  it('uses the diff text to decide on .npmrc', () => {
    expect(skipReason(file('.npmrc'), 1, new Set(), [hunk('registry=https://registry.npmjs.org/')])).toBeNull();
    expect(skipReason(file('.npmrc'), 1, new Set(), [hunk('//registry.npmjs.org/:_authToken=abc')])).toMatch(/credentials/);
  });
});

describe('dropSecretFilePatches', () => {
  it('removes secret files from a patch and says what it removed', () => {
    const patch = ['diff --git a/src/a.ts b/src/a.ts\n+ok\n', 'diff --git a/.env b/.env\n+TOKEN=abc\n', 'diff --git a/b.pem b/b.pem\n+-----BEGIN\n', 'diff --git a/src/c.ts b/src/c.ts\n+fine\n'].join('');
    const out = dropSecretFilePatches(patch);
    expect(out.patch).toContain('src/a.ts');
    expect(out.patch).toContain('src/c.ts');
    expect(out.patch).not.toContain('TOKEN=abc');
    expect(out.patch).not.toContain('BEGIN');
    expect(out.skipped.map((s) => s.split(':')[0])).toEqual(['.env', 'b.pem']);
  });
});

describe('scrubbing before upload', () => {
  const echo = (): { backend: AiBackend; last: () => AiRequest } => {
    let last: AiRequest | undefined;
    return { backend: { name: 'anthropic', complete: async (r) => ((last = r), { json: {}, model: 'm' }) }, last: () => last! };
  };
  const base = { system: 'SYS', schema: {}, model: 'm', effort: 'low' as const };

  it('masks token shapes in prompt and sharedPrompt but keeps line structure', async () => {
    const { backend, last } = echo();
    const key = 'sk-' + 'a'.repeat(30);
    await withScrubbing(backend).complete({ ...base, prompt: `+const k = "${key}";\n+// ghp_${'b'.repeat(25)}\n+AKIA${'C'.repeat(16)}`, sharedPrompt: 'Authorization: Bearer abc.def.ghi' });
    expect(last().prompt).not.toContain(key);
    expect(last().prompt).not.toContain('ghp_bbbb');
    expect(last().prompt).not.toContain('AKIACCCC');
    expect(last().prompt.split('\n')).toHaveLength(3);
    expect(last().sharedPrompt).toBe('Authorization: Bearer ***');
    expect(last().system).toBe('SYS');
  });

  it('does not invent a sharedPrompt', async () => {
    const { backend, last } = echo();
    await withScrubbing(backend).complete({ ...base, prompt: 'plain' });
    expect(last().sharedPrompt).toBeUndefined();
  });

  it('scrubSecrets still masks Anthropic keys as before', () => {
    expect(scrubSecrets('sk-ant-api03-abcdefghijkl')).toBe('sk-ant-***');
  });
});
