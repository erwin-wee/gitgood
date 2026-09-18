import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRepoConfig, readRepoConfig } from '../src/main/repo/config';
import { resolveCheckCommand } from '../src/main/ai/check-runner';

describe('parseRepoConfig', () => {
  it('reads a valid postResolveCheck command', () => {
    expect(parseRepoConfig({ postResolveCheck: 'npm run typecheck' })).toEqual({ postResolveCheck: 'npm run typecheck' });
  });

  it('treats a missing field as no command', () => {
    expect(parseRepoConfig({})).toEqual({ postResolveCheck: null });
  });

  it('treats a blank command as no command', () => {
    expect(parseRepoConfig({ postResolveCheck: '   ' })).toEqual({ postResolveCheck: null });
  });

  it('treats malformed input as no command', () => {
    expect(parseRepoConfig(null)).toEqual({ postResolveCheck: null });
    expect(parseRepoConfig('not an object')).toEqual({ postResolveCheck: null });
    expect(parseRepoConfig({ postResolveCheck: 42 })).toEqual({ postResolveCheck: null });
  });
});

describe('readRepoConfig (fixture)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads .gitgood/config.json from the repository root', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gitgood-repo-config-'));
    mkdirSync(join(dir, '.gitgood'));
    writeFileSync(join(dir, '.gitgood', 'config.json'), JSON.stringify({ postResolveCheck: 'npm run typecheck' }));
    expect(await readRepoConfig(dir)).toEqual({ postResolveCheck: 'npm run typecheck' });
  });

  it('returns no command when the file is absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gitgood-repo-config-'));
    expect(await readRepoConfig(dir)).toEqual({ postResolveCheck: null });
  });

  it('returns no command when the file is malformed JSON, without throwing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gitgood-repo-config-'));
    mkdirSync(join(dir, '.gitgood'));
    writeFileSync(join(dir, '.gitgood', 'config.json'), '{ not json');
    expect(await readRepoConfig(dir)).toEqual({ postResolveCheck: null });
  });

  it('the trust gate refuses a command read from an untrusted repository, even though the file declares one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gitgood-repo-config-'));
    mkdirSync(join(dir, '.gitgood'));
    writeFileSync(join(dir, '.gitgood', 'config.json'), JSON.stringify({ postResolveCheck: 'rm -rf /' }));
    const repoConfig = await readRepoConfig(dir);
    expect(resolveCheckCommand({ userCommand: null, repoCommand: repoConfig.postResolveCheck, fromRepoEnabled: true, trusted: undefined })).toBeNull();
    expect(resolveCheckCommand({ userCommand: null, repoCommand: repoConfig.postResolveCheck, fromRepoEnabled: true, trusted: false })).toBeNull();
    expect(resolveCheckCommand({ userCommand: null, repoCommand: repoConfig.postResolveCheck, fromRepoEnabled: true, trusted: true })).toEqual({ command: 'rm -rf /', fromRepo: true });
  });
});
