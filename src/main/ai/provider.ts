import type { AiSettings } from '@shared/types';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError, AnthropicBackend, ClaudeCliBackend, type AiBackend } from './backends';

/** Creates the AI backend selected in settings, or throws a not-configured AiError. */
export async function createBackend(store: Store, tools: ToolLocator): Promise<{ backend: AiBackend; settings: AiSettings }> {
  const settings = store.getSettings().ai;
  if (settings.provider === 'disabled') throw new AiError('AI features are turned off. Enable them in Options → AI.', 'not-configured');
  if (settings.provider === 'claude-cli') {
    const path = tools.claudePath();
    if (!path) throw new AiError('Claude Code CLI was not found. Install it or switch to an Anthropic API key in Options → AI.', 'not-configured');
    return { backend: new ClaudeCliBackend(path, await tools.env()), settings };
  }
  const key = store.getApiKey();
  if (!key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AiError('No Anthropic API key is configured. Add one in Options → AI, or switch to the Claude Code CLI.', 'not-configured');
  }
  return { backend: new AnthropicBackend(key), settings };
}
