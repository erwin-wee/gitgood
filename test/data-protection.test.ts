import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { ErrorExplainService } from '../src/main/ai/error-explain';
import { createBackend } from '../src/main/ai/provider';
import { initLogger, log } from '../src/main/logger';
import { Store } from '../src/main/store';

vi.mock('../src/main/ai/provider', () => ({ createBackend: vi.fn() }));

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'gg-data-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Store file permissions', () => {
  it('writes secrets.json owner-only and creates the data directory 0700', () => {
    const dir = join(tmp(), 'data');
    const store = new Store(dir);
    store.load();
    store.setApiKey('sk-ant-plaintext-fallback-key');
    expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('Store corrupt JSON', () => {
  it('moves an unparseable settings.json aside instead of silently overwriting it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), '{ "theme": "dark", oops');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new Store(dir);
    store.load();
    expect(store.getSettings().ai).toBeDefined();
    const kept = readdirSync(dir).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe('{ "theme": "dark", oops');
  });

  it('does not create a .corrupt file when the file is simply missing', () => {
    const dir = tmp();
    new Store(dir).load();
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
  });
});

describe('logger redaction', () => {
  it('scrubs secrets from every line and creates the log owner-only', () => {
    const dir = tmp();
    initLogger(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    log.info('git clone https://alice:hunter2@github.com/o/r.git');
    log.error('boom with ghp_1234567890abcdefghij1234567890ABCD', new Error('Authorization: Bearer abc.def.ghi'));
    const text = readFileSync(join(dir, 'gitgood.log'), 'utf8');
    expect(text).not.toMatch(/hunter2|ghp_1234567890|abc\.def\.ghi/);
    expect(text).toContain('https://***:***@github.com');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'gitgood.log')).mode & 0o777).toBe(0o600);
  });
});

describe('ErrorExplainService', () => {
  it('sends the failed command to the model with secrets scrubbed', async () => {
    let prompt = '';
    const complete = vi.fn(async (req: { prompt: string }) => {
      prompt = req.prompt;
      return { json: {}, model: 'm' };
    });
    vi.mocked(createBackend).mockResolvedValue({ backend: { name: 'claude-cli', complete }, settings: { ...DEFAULT_SETTINGS.ai } } as never);
    const tools = { current: () => ({ git: { version: '2.45.0' }, gh: { installed: false, version: null } }) };
    const service = new ErrorExplainService({} as never, tools as never, {} as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await service.explainError(null, { code: 'auth', command: 'git push https://alice:hunter2@github.com/o/r.git', exitCode: 128, stderr: '', stdout: '', message: 'x' } as never, false).catch(() => {});
    expect(prompt).toContain('https://***:***@github.com');
    expect(prompt).not.toContain('hunter2');
  });
});
