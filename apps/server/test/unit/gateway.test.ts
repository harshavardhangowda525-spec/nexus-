import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costOf, ModelGateway } from '../../src/models/gateway.js';
import type { ChatRequest } from '../../src/models/types.js';

// A local HTTP server standing in for each provider's real API shape.
let server: http.Server;
let base = '';
const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
let failNext = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url!, headers: req.headers, body });
      if (failNext > 0) { failNext--; res.writeHead(529, { 'content-type': 'application/json' }).end('{"error":{"type":"overloaded_error","message":"busy"}}'); return; }
      res.setHeader('content-type', 'application/json');
      if (req.url!.startsWith('/v1/messages')) {
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', stop_sequence: null,
          content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
      } else if (req.url!.includes(':generateContent')) {
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok', thoughtSignature: 'ts' }, { functionCall: { name: 'browse', args: { url: 'https://example.com' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 }, modelVersion: 'gemini-test',
        }));
      } else if (req.url!.endsWith('/chat/completions')) {
        res.end(JSON.stringify({
          model: body.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] } }],
          usage: { prompt_tokens: 30, completion_tokens: 5 },
        }));
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req: ChatRequest = {
  system: 'You are a test agent.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Start' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'prev_1', name: 'list_files', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prev_1', content: 'a.md' }] },
  ],
  tools: [{ name: 'write_file', description: 'w', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
};

describe('ModelGateway adapters', () => {
  it('Anthropic: uses the SDK, sends effort and fallbacks, normalizes tool use, keeps raw blocks', async () => {
    const gw = new ModelGateway({ baseDelayMs: 1 });
    const r = await gw.chat({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test', baseUrl: base, effort: 'high' }, req);
    const call = seen.at(-1)!;
    expect(call.url).toContain('/v1/messages');
    // SDK 1.x sends the API key as a bearer token; only the workspace key is used.
    expect(call.headers.authorization).toBe('Bearer sk-ant-test');
    expect(call.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(call.body.fallbacks).toBe('default');
    expect(call.body.output_config).toEqual({ effort: 'high' });
    expect(call.body.temperature).toBeUndefined();
    expect(call.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'prev_1' });
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toEqual([{ type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }]);
    expect((r.raw as any[])[0].type).toBe('thinking'); // replayed unchanged next turn
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(r.costUsd).toBeCloseTo((100 * 4 + 20 * 20) / 1e6, 10);

    // Raw content is sent back verbatim on the next request.
    await gw.chat({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', baseUrl: base }, { ...req, messages: [...req.messages, { role: 'assistant', content: r.content, raw: { provider: 'anthropic', content: r.raw } }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }] });
    expect(seen.at(-1)!.body.messages[3].content[0]).toMatchObject({ type: 'thinking', signature: 'sig' });
  });

  it('OpenAI-compatible: maps tools and tool results, parses tool calls', async () => {
    const r = await new ModelGateway().chat({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-oa', baseUrl: `${base}/v1` }, req);
    const call = seen.at(-1)!;
    expect(call.headers.authorization).toBe('Bearer sk-oa');
    expect(call.body.messages[0]).toEqual({ role: 'system', content: 'You are a test agent.' });
    expect(call.body.messages[2].tool_calls[0].function.name).toBe('list_files');
    expect(call.body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'prev_1', content: 'a.md' });
    expect(call.body.tools[0].function.parameters.required).toEqual(['path']);
    expect(r.content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'run_command', input: { command: 'ls' } });
    expect(r.priced).toBe(false); // unknown model: recorded as unpriced, not free
  });

  it('Ollama: OpenAI-compatible without a key', async () => {
    const r = await new ModelGateway().chat({ provider: 'ollama', model: 'llama3.1', baseUrl: `${base}/v1` }, req);
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
    expect(r.priced).toBe(true);
    expect(r.costUsd).toBe(0);
  });

  it('Gemini: function declarations without unsupported schema keys, function responses by name, raw parts kept', async () => {
    const r = await new ModelGateway().chat({ provider: 'gemini', model: 'gemini-test', apiKey: 'g-key', baseUrl: base }, req);
    const call = seen.at(-1)!;
    expect(call.url).toBe('/v1beta/models/gemini-test:generateContent');
    expect(call.headers['x-goog-api-key']).toBe('g-key');
    expect(call.body.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
    expect(call.body.contents[2].parts[0].functionResponse).toEqual({ name: 'list_files', response: { content: 'a.md' } });
    expect(r.content[1]).toMatchObject({ type: 'tool_use', name: 'browse', input: { url: 'https://example.com' } });
    expect((r.raw as any[])[0].thoughtSignature).toBe('ts');
  });

  it('retries transient errors with backoff, then succeeds', async () => {
    failNext = 2;
    const r = await new ModelGateway({ baseDelayMs: 1 }).chat({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: `${base}/v1` }, req);
    expect(r.attempts).toBe(3);
  });

  it('gives up after the retry limit', async () => {
    failNext = 10;
    await expect(new ModelGateway({ baseDelayMs: 1, maxRetries: 1 }).chat({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: `${base}/v1` }, req)).rejects.toThrow(/529/);
    failNext = 0;
  });

  it('refuses to call a keyed provider without a key', async () => {
    await expect(new ModelGateway().chat({ provider: 'openai', model: 'm', baseUrl: `${base}/v1` }, req)).rejects.toThrow(/No API key/);
  });

  it('prices known Claude models', () => {
    expect(costOf('anthropic', 'claude-sonnet-5-5', 1_000_000, 1_000_000)).toEqual({ priced: true, usd: 12 });
    expect(costOf('anthropic', 'claude-haiku-5-5', 1_000_000, 0).usd).toBeCloseTo(0.1);
  });
});
