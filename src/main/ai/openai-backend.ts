import { scrubSecrets } from '@shared/secrets';
import { AiError, extractJson, type AiBackend, type AiRequest, type AiResponse } from './backends';

/** A single completion on a local model can be slow; this bounds a hung server without cutting off a legitimate long answer. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

/**
 * Backend for any server that speaks OpenAI's `POST {base}/chat/completions`
 * (OpenAI, Azure-compatible gateways, Ollama, LM Studio, vLLM, OpenRouter, …).
 * Asks for strict `json_schema` output; servers that reject that response
 * format get one retry with `json_object` and the schema spelled out in the
 * system prompt. Effort is not sent: there is no portable equivalent.
 */
export class OpenAiBackend implements AiBackend {
  readonly name = 'openai-compatible' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    req.onProgress?.('Contacting the AI server…');
    const strict = await this.post(req, true);
    const res = strict.status === 400 || strict.status === 422 ? await this.post(req, false) : strict;
    return this.parse(req, res.status, res.body);
  }

  private async post(req: AiRequest, useJsonSchema: boolean): Promise<{ status: number; body: string }> {
    const system = useJsonSchema ? req.system : `${req.system}\n\nRespond with a single JSON object (no prose, no code fences) that conforms to this JSON Schema:\n${JSON.stringify(req.schema)}`;
    const body = {
      model: req.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.sharedPrompt ? `${req.sharedPrompt}\n\n${req.prompt}` : req.prompt },
      ],
      response_format: useJsonSchema ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: req.schema } } : { type: 'json_object' },
      stream: false,
    };
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      if (req.signal?.aborted) throw new AiError('Cancelled', 'cancelled');
      if (timeout.aborted) throw new AiError('The AI server did not answer within 10 minutes.', 'network');
      throw new AiError(`Could not reach the AI server at ${this.baseUrl}: ${scrubSecrets((err as Error).message ?? String(err))}`, 'network');
    }
  }

  private parse(req: AiRequest, status: number, text: string): AiResponse {
    let data: ChatCompletion = {};
    try {
      data = JSON.parse(text) as ChatCompletion;
    } catch {
      /* non-JSON body (HTML error page, proxy text): handled by the status / empty-choice checks below */
    }
    if (status < 200 || status >= 300) {
      const detail = scrubSecrets(data.error?.message ?? text).slice(0, 300);
      if (status === 401 || status === 403) throw new AiError('The AI server rejected the API key. Check it in Options → AI.', 'auth');
      if (status === 404) throw new AiError(`The AI server returned 404 for model "${req.model}" or the endpoint. Check the base URL and model name in Options → AI.`, 'other');
      if (status === 429) throw new AiError('The AI server rate limit was reached. Wait a moment and try again.', 'rate-limit');
      throw new AiError(`The AI server returned HTTP ${status}${detail ? `: ${detail}` : ''}`, 'other');
    }
    const choice = data.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new AiError(`The model declined this request${choice.message?.refusal ? `: ${choice.message.refusal}` : ''}.`, 'refusal');
    if (choice?.finish_reason === 'length') throw new AiError('The response was too long and was cut off. Try reviewing fewer files at once.', 'truncated');
    const content = choice?.message?.content;
    if (!content) throw new AiError('The AI server returned an empty response. Check that the base URL points at an OpenAI-compatible /chat/completions endpoint.', 'invalid-output');
    let json: unknown;
    try {
      json = extractJson(content);
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError('The model returned malformed JSON.', 'invalid-output');
    }
    const usage = data.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      json,
      model: data.model || req.model,
      // OpenAI counts cached tokens inside prompt_tokens; AiUsage keeps them separate.
      usage: usage ? { inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached), outputTokens: usage.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0, costUsd: null } : undefined,
    };
  }
}
