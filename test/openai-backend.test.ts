import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiError, type AiRequest } from '../src/main/ai/backends';
import { OpenAiBackend } from '../src/main/ai/openai-backend';

interface Seen {
  url: string;
  auth: string | undefined;
  body: Record<string, any>;
}

let server: Server;
let base: string;
let seen: Seen[];
/** One entry per expected request: [status, body]. */
let replies: [number, unknown][];

const ok = (content: string, extra: Record<string, unknown> = {}) => ({ model: 'served-model', choices: [{ message: { content }, finish_reason: 'stop' }], ...extra });
const req = (over: Partial<AiRequest> = {}): AiRequest => ({ system: 'SYS', prompt: 'PROMPT', schema: { type: 'object', properties: { a: { type: 'number' } } }, model: 'my-model', effort: 'high', ...over });

beforeEach(async () => {
  seen = [];
  replies = [];
  server = createServer((incoming: IncomingMessage, res) => {
    let raw = '';
    incoming.on('data', (c) => (raw += c));
    incoming.on('end', () => {
      seen.push({ url: incoming.url ?? '', auth: incoming.headers.authorization, body: JSON.parse(raw) });
      const [status, body] = replies.shift() ?? [500, { error: { message: 'no reply queued' } }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('OpenAiBackend', () => {
  it('posts a strict json_schema request to {base}/chat/completions with the bearer key and maps usage', async () => {
    replies.push([200, ok('{"a":1}', { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })]);
    const res = await new OpenAiBackend(base, 'sk-test').complete(req({ sharedPrompt: 'SHARED' }));
    expect(res.json).toEqual({ a: 1 });
    expect(res.model).toBe('served-model');
    expect(res.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0, costUsd: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/chat/completions');
    expect(seen[0].auth).toBe('Bearer sk-test');
    expect(seen[0].body.model).toBe('my-model');
    expect(seen[0].body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', strict: true, schema: req().schema } });
    expect(seen[0].body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'SHARED\n\nPROMPT' },
    ]);
  });

  it('sends no Authorization header without a key (local servers)', async () => {
    replies.push([200, ok('{}')]);
    await new OpenAiBackend(base, null).complete(req());
    expect(seen[0].auth).toBeUndefined();
  });

  it('retries once with json_object and the schema in the system prompt when json_schema is rejected', async () => {
    replies.push([400, { error: { message: "response_format 'json_schema' is not supported" } }], [200, ok('```json\n{"a":2}\n```')]);
    const res = await new OpenAiBackend(base, null).complete(req());
    expect(res.json).toEqual({ a: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[1].body.response_format).toEqual({ type: 'json_object' });
    expect(seen[1].body.messages[0].content).toContain('SYS');
    expect(seen[1].body.messages[0].content).toContain(JSON.stringify(req().schema));
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate-limit'],
    [404, 'other'],
    [503, 'other'],
  ])('maps HTTP %i to AiError kind %s', async (status, kind) => {
    replies.push([status, { error: { message: 'nope sk-secretsecretsecretsecret' } }]);
    const err = await new OpenAiBackend(base, 'k').complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain('sk-secretsecretsecretsecret');
  });

  it('reports a still-rejected request after the fallback as an error', async () => {
    replies.push([400, { error: { message: 'bad' } }], [400, { error: { message: 'still bad' } }]);
    const err = await new OpenAiBackend(base, null).complete(req()).catch((e) => e);
    expect(err.kind).toBe('other');
    expect(err.message).toContain('still bad');
  });

  it('maps truncation, refusals and empty or non-JSON answers', async () => {
    const backend = new OpenAiBackend(base, null);
    replies.push([200, { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }]);
    expect((await backend.complete(req()).catch((e) => e)).kind).toBe('truncated');
    replies.push([200, { choices: [{ message: { content: null, refusal: 'cannot help' }, finish_reason: 'stop' }] }]);
    expect((await backend.complete(req()).catch((e) => e)).kind).toBe('refusal');
    replies.push([200, { choices: [] }]);
    expect((await backend.complete(req()).catch((e) => e)).kind).toBe('invalid-output');
    replies.push([200, ok('definitely not json')]);
    expect((await backend.complete(req()).catch((e) => e)).kind).toBe('invalid-output');
  });

  it('maps an unreachable server to network and an aborted signal to cancelled', async () => {
    const dead = new OpenAiBackend('http://127.0.0.1:1/v1', null);
    expect((await dead.complete(req()).catch((e) => e)).kind).toBe('network');
    const controller = new AbortController();
    controller.abort();
    expect((await new OpenAiBackend(base, null).complete(req({ signal: controller.signal })).catch((e) => e)).kind).toBe('cancelled');
  });
});
