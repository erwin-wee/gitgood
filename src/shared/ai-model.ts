import type { AiFeature, AiSettings, AppSettings, RepositoryInfo } from './types';

/** Model for one feature: its non-empty override, else the global model of the active provider. */
export function modelFor(settings: Pick<AiSettings, 'provider' | 'model' | 'openaiModel' | 'featureModels'>, feature: AiFeature): string {
  const override = settings.featureModels?.[feature]?.trim();
  if (override) return override;
  return settings.provider === 'openai-compatible' ? settings.openaiModel : settings.model;
}

/** True when AI is switched off for this repository, by the local toggle or by `"ai": false` in `.gitgood/config.json`. */
export function repoAiDisabled(repo: Pick<RepositoryInfo, 'aiDisabled' | 'aiConfigOff'> | null | undefined): boolean {
  return !!repo && (!!repo.aiDisabled || !!repo.aiConfigOff);
}

/** AI is usable: a provider is selected and the repository (if any) has not opted out. */
export function aiEnabled(settings: Pick<AppSettings, 'ai'> | null | undefined, repo: Pick<RepositoryInfo, 'aiDisabled' | 'aiConfigOff'> | null | undefined): boolean {
  return (settings?.ai.provider ?? 'disabled') !== 'disabled' && !repoAiDisabled(repo);
}

/** Where prompts go, for "this is sent to …" copy. */
export function aiProviderLabel(ai: Pick<AiSettings, 'provider' | 'openaiBaseUrl'> | undefined): string {
  if (ai?.provider === 'claude-cli') return 'Claude Code';
  if (ai?.provider === 'openai-compatible') return `the AI server at ${ai.openaiBaseUrl || '(no URL set)'}`;
  return 'the Anthropic API';
}
