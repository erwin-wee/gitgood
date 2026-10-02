import { describe, expect, it } from 'vitest';
import { aiEnabled, modelFor, repoAiDisabled } from '../src/shared/ai-model';
import { DEFAULT_SETTINGS } from '../src/shared/types';

const ai = { ...DEFAULT_SETTINGS.ai, model: 'claude-opus-5', openaiModel: 'gpt-x' };

describe('modelFor', () => {
  it('uses the global model when a feature has no override or a blank one', () => {
    expect(modelFor(ai, 'review')).toBe('claude-opus-5');
    expect(modelFor({ ...ai, featureModels: { review: '   ' } }, 'review')).toBe('claude-opus-5');
  });

  it('uses the feature override, only for that feature', () => {
    const settings = { ...ai, featureModels: { commitMessage: 'claude-haiku-4-5' } };
    expect(modelFor(settings, 'commitMessage')).toBe('claude-haiku-4-5');
    expect(modelFor(settings, 'review')).toBe('claude-opus-5');
  });

  it('falls back to the OpenAI-compatible model on that provider', () => {
    expect(modelFor({ ...ai, provider: 'openai-compatible' }, 'explain')).toBe('gpt-x');
    expect(modelFor({ ...ai, provider: 'openai-compatible', featureModels: { explain: 'small' } }, 'explain')).toBe('small');
  });
});

describe('per-repository AI opt-out', () => {
  it('is off for either the local toggle or the config-file flag', () => {
    expect(repoAiDisabled({ aiDisabled: true })).toBe(true);
    expect(repoAiDisabled({ aiConfigOff: true })).toBe(true);
    expect(repoAiDisabled({})).toBe(false);
    expect(repoAiDisabled(null)).toBe(false);
  });

  it('aiEnabled needs a provider and an opted-in repository', () => {
    expect(aiEnabled({ ai }, { })).toBe(true);
    expect(aiEnabled({ ai }, { aiDisabled: true })).toBe(false);
    expect(aiEnabled({ ai: { ...ai, provider: 'disabled' } }, {})).toBe(false);
    expect(aiEnabled(null, {})).toBe(false);
  });
});
