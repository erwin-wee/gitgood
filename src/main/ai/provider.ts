import type { AiFeature, AiSettings } from '@shared/types';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError, AnthropicBackend, ClaudeCliBackend, withScrubbing, type AiBackend } from './backends';
import { modelFor } from '@shared/ai-model';
import { OpenAiBackend } from './openai-backend';
import { recordUsage } from './usage';

/** Scrubs secrets from the prompt of every feature but the resolver (whose text is written back to the file), and records every successful request's usage under `feature` (best-effort; see usage.ts). */
function withUsage(backend: AiBackend, feature: AiFeature): AiBackend {
  const inner = feature === 'resolver' ? backend : withScrubbing(backend);
  return {
    name: backend.name,
    async complete(req) {
      const res = await inner.complete(req);
      void recordUsage(feature, res.usage);
      return res;
    },
  };
}

/** Creates the AI backend selected in settings, or throws a not-configured AiError. Usage of the returned backend is recorded under `feature`. */
export async function createBackend(store: Store, tools: ToolLocator, feature: AiFeature): Promise<{ backend: AiBackend; settings: AiSettings }> {
  const settings = store.getSettings().ai;
  if (settings.provider === 'disabled') throw new AiError('AI features are turned off. Enable them in Options → AI.', 'not-configured');
  if (settings.provider === 'claude-cli') {
    await tools.ensure('claudeCli');
    const path = tools.claudePath();
    if (!path) throw new AiError('Claude Code CLI was not found. Install it or switch to an Anthropic API key in Options → AI.', 'not-configured');
    return { backend: withUsage(new ClaudeCliBackend(path, await tools.env()), feature), settings };
  }
  if (settings.provider === 'openai-compatible') {
    let valid = false;
    try {
      valid = /^https?:$/.test(new URL(settings.openaiBaseUrl).protocol);
    } catch {
      /* falls through to the not-configured error */
    }
    if (!valid) throw new AiError('No valid base URL is set for the OpenAI-compatible server. Add one in Options → AI.', 'not-configured');
    if (!modelFor(settings, feature)) throw new AiError('No model name is set for the OpenAI-compatible server. Add one in Options → AI.', 'not-configured');
    return { backend: withUsage(new OpenAiBackend(settings.openaiBaseUrl, store.getOpenaiApiKey()), feature), settings };
  }
  const key = store.getApiKey();
  if (!key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AiError('No Anthropic API key is configured. Add one in Options → AI, or switch to the Claude Code CLI.', 'not-configured');
  }
  return { backend: withUsage(new AnthropicBackend(key), feature), settings };
}
