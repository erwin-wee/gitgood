import Anthropic from '@anthropic-ai/sdk';
import { tmpdir } from 'node:os';
import type { AiUsage, EffortLevel } from '@shared/types';
import { scrubSecrets } from '@shared/secrets';
import { ExecError, exec } from '../exec';
import { log } from '../logger';

export interface AiRequest {
  system: string;
  prompt: string;
  /** Leading part of the user message that is identical across a run's requests (e.g. the PR context of a per-file review). Sent first as a cache-marked block; the full text is `sharedPrompt + '\n\n' + prompt`. */
  sharedPrompt?: string;
  schema: Record<string, unknown>;
  model: string;
  effort: EffortLevel;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface AiResponse {
  json: unknown;
  model: string;
  /** Token usage as reported by the backend; absent when it reports none. */
  usage?: AiUsage;
}

export interface AiBackend {
  readonly name: 'anthropic' | 'claude-cli' | 'openai-compatible';
  complete(req: AiRequest): Promise<AiResponse>;
}

export class AiError extends Error {
  constructor(message: string, readonly kind: 'not-configured' | 'auth' | 'rate-limit' | 'refusal' | 'truncated' | 'invalid-output' | 'network' | 'cancelled' | 'stale' | 'other' = 'other') {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * Masks known secret shapes in the user-message text before it leaves the machine. Used for every
 * read-only feature; never for the conflict resolver, whose output is written back to the file and
 * so must see (and return) the real content.
 */
export function withScrubbing(backend: AiBackend): AiBackend {
  return {
    name: backend.name,
    complete: (req) => backend.complete({ ...req, prompt: scrubSecrets(req.prompt), sharedPrompt: req.sharedPrompt === undefined ? undefined : scrubSecrets(req.sharedPrompt) }),
  };
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fence) return JSON.parse(fence[1]);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new AiError('The model did not return valid JSON.', 'invalid-output');
  }
}

/** Models that understand adaptive thinking / effort. Haiku 4.5 predates them. */
function supportsAdaptiveThinking(model: string): boolean {
  return !/haiku/i.test(model);
}

/** Server-side refusal fallbacks are defined for the Opus 5 / Fable tiers. */
function supportsServerFallbacks(model: string): boolean {
  return /claude-(opus-5|fable|mythos)/i.test(model);
}

/** Request body for the Anthropic API. The system prompt and the shared leading prompt block carry `cache_control` so repeated calls of one run read them from the prompt cache. */
export function buildAnthropicParams(req: AiRequest) {
  const adaptive = supportsAdaptiveThinking(req.model);
  const fallbacks = supportsServerFallbacks(req.model) ? { betas: ['server-side-fallback-2026-07-01' as const], fallbacks: 'default' as const } : {};
  const thinking = adaptive ? { thinking: { type: 'adaptive' as const } } : {};
  const cache = { type: 'ephemeral' as const };
  const content = req.sharedPrompt
    ? [
        { type: 'text' as const, text: `${req.sharedPrompt}\n\n`, cache_control: cache },
        { type: 'text' as const, text: req.prompt },
      ]
    : req.prompt;
  return {
    model: req.model,
    max_tokens: 64000,
    system: [{ type: 'text' as const, text: req.system, cache_control: cache }],
    messages: [{ role: 'user' as const, content }],
    output_config: {
      format: { type: 'json_schema' as const, schema: req.schema },
      ...(adaptive ? { effort: req.effort } : {}),
    },
    ...thinking,
    ...fallbacks,
  };
}

/**
 * Anthropic API backend. Uses streaming so long resolutions never hit HTTP
 * timeouts, structured JSON output so the result parses reliably, and the
 * server-side refusal fallback so a false-positive classifier decline is
 * retried on a fallback model within the same request.
 */
export class AnthropicBackend implements AiBackend {
  readonly name = 'anthropic' as const;

  constructor(private readonly apiKey: string | null) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    const client = new Anthropic({ apiKey: this.apiKey ?? undefined, timeout: 20 * 60 * 1000, maxRetries: 2 });
    req.onProgress?.('Contacting Claude…');
    try {
      const stream = client.beta.messages.stream(buildAnthropicParams(req), { signal: req.signal });
      let started = false;
      stream.on('text', () => {
        if (!started) {
          started = true;
          req.onProgress?.('Writing response…');
        }
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.type === 'refusal' ? message.stop_details.category : null;
        throw new AiError(`Claude declined this request${category ? ` (${category})` : ''}. Try a different model or adjust the request.`, 'refusal');
      }
      if (message.stop_reason === 'max_tokens') throw new AiError('The response was too long and was cut off. Try again with a smaller selection.', 'truncated');
      const text = message.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const servedBy = message.model;
      const fellBack = (message.usage.iterations ?? []).some((it) => it.type === 'fallback_message');
      if (fellBack) log.info(`AI request served by fallback model ${servedBy}`);
      const u = message.usage;
      const usage: AiUsage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, costUsd: null };
      return { json: extractJson(text), model: servedBy, usage };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (req.signal?.aborted) throw new AiError('Cancelled', 'cancelled');
      if (err instanceof Anthropic.AuthenticationError) throw new AiError('The Anthropic API key was rejected. Check it in Options → AI.', 'auth');
      if (err instanceof Anthropic.PermissionDeniedError) throw new AiError(`Anthropic API access denied: ${err.message}`, 'auth');
      if (err instanceof Anthropic.NotFoundError) throw new AiError(`Model "${req.model}" is not available to your account.`, 'other');
      if (err instanceof Anthropic.RateLimitError) throw new AiError('Anthropic rate limit reached. Wait a moment and try again.', 'rate-limit');
      if (err instanceof Anthropic.BadRequestError) throw new AiError(`Anthropic API rejected the request: ${err.message}`, 'other');
      if (err instanceof Anthropic.APIConnectionError) throw new AiError('Could not reach the Anthropic API. Check your network connection.', 'network');
      if (err instanceof Anthropic.APIError) throw new AiError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, 'other');
      if (err instanceof SyntaxError) throw new AiError('The model returned malformed JSON.', 'invalid-output');
      throw new AiError((err as Error).message ?? String(err), 'other');
    }
  }
}

/**
 * Claude Code CLI backend: reuses the user's existing `claude` login, so no
 * API key is needed. Runs headless with tools disabled and structured output.
 */
export class ClaudeCliBackend implements AiBackend {
  readonly name = 'claude-cli' as const;

  constructor(private readonly cliPath: string, private readonly env: NodeJS.ProcessEnv) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    req.onProgress?.('Running Claude Code…');
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(req.schema), '--tools', '', '--no-session-persistence', '--system-prompt', req.system, '--model', req.model, '--effort', req.effort];
    const env = { ...this.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    try {
      const res = await exec(this.cliPath, args, { cwd: tmpdir(), env, stdin: req.sharedPrompt ? `${req.sharedPrompt}\n\n${req.prompt}` : req.prompt, signal: req.signal, timeoutMs: 20 * 60 * 1000, okExitCodes: [1] });
      const text = res.stdout.trim();
      let parsed: { is_error?: boolean; result?: string; structured_output?: unknown; subtype?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | null = null;
      try {
        parsed = JSON.parse(text.slice(text.indexOf('{')));
      } catch {
        throw new AiError(`Claude Code returned unexpected output: ${(text || res.stderr).slice(0, 300)}`, 'invalid-output');
      }
      if (!parsed || parsed.is_error) {
        const msg = parsed?.result ?? res.stderr ?? 'unknown error';
        if (/not logged in|login/i.test(msg)) throw new AiError('Claude Code is not signed in. Run `claude` in a terminal and sign in, or switch to an API key.', 'auth');
        if (/rate limit|usage limit|limit reached/i.test(msg)) throw new AiError(`Claude Code usage limit: ${msg}`, 'rate-limit');
        throw new AiError(`Claude Code error: ${msg}`, 'other');
      }
      const json = parsed.structured_output ?? (parsed.result ? extractJson(parsed.result) : null);
      if (json === null || json === undefined) throw new AiError('Claude Code returned no structured output.', 'invalid-output');
      const u = parsed.usage;
      const usage: AiUsage | undefined = u || parsed.total_cost_usd !== undefined ? { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheWriteTokens: u?.cache_creation_input_tokens ?? 0, costUsd: parsed.total_cost_usd ?? null } : undefined;
      return { json, model: req.model, usage };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (req.signal?.aborted) throw new AiError('Cancelled', 'cancelled');
      if (err instanceof ExecError) throw new AiError(`Claude Code failed: ${err.message.slice(0, 300)}`, 'other');
      throw new AiError((err as Error).message, 'other');
    }
  }
}
