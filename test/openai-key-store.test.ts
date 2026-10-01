import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/main/store';

const dirs: string[] = [];
const newStore = (): Store => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-openai-'));
  dirs.push(dir);
  const store = new Store(dir);
  store.load();
  return store;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const exportFile = (baseUrl: string) => ({ schema: 1, app: 'gitgood', version: '1', exportedAt: 'x', platform: process.platform, preferences: { ai: { openaiBaseUrl: baseUrl } } });

describe('OpenAI-compatible API key', () => {
  it('is stored separately from the Anthropic key and flagged in settings', () => {
    const store = newStore();
    store.setApiKey('anthropic-key');
    store.setOpenaiApiKey('openai-key');
    expect(store.getApiKey()).toBe('anthropic-key');
    expect(store.getOpenaiApiKey()).toBe('openai-key');
    expect(store.getSettings().ai).toMatchObject({ hasApiKey: true, hasOpenaiApiKey: true });
    store.setOpenaiApiKey(null);
    expect(store.getOpenaiApiKey()).toBeNull();
    expect(store.getApiKey()).toBe('anthropic-key');
    expect(store.getSettings().ai.hasOpenaiApiKey).toBe(false);
  });

  it('never appears in an export', () => {
    const store = newStore();
    store.setOpenaiApiKey('openai-secret-value');
    expect(JSON.stringify(store.buildExport(['preferences', 'integrations', 'repositories'], []))).not.toContain('openai-secret-value');
  });

  it('is dropped when an import changes the base URL, so a file cannot redirect it', () => {
    const store = newStore();
    store.updateSettings({ ai: { ...store.getSettings().ai, openaiBaseUrl: 'https://api.openai.com/v1' } });
    store.setOpenaiApiKey('openai-secret-value');
    store.importSettings(exportFile('https://api.openai.com/v1'), 'merge', ['preferences']);
    expect(store.getOpenaiApiKey()).toBe('openai-secret-value');
    store.importSettings(exportFile('https://attacker.example/v1'), 'merge', ['preferences']);
    expect(store.getOpenaiApiKey()).toBeNull();
    expect(store.getSettings().ai.openaiBaseUrl).toBe('https://attacker.example/v1');
    expect(readFileSync(join(dirs[0], 'secrets.json'), 'utf8')).not.toContain('openai-secret-value');
  });
});
