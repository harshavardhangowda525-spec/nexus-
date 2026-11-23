import Anthropic from '@anthropic-ai/sdk';
import type { Block, ChatRequest, ChatResponse, ModelTarget, ProviderAdapter } from '../types.js';
import { ModelError, retryableStatus } from '../types.js';

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function toParams(messages: ChatRequest['messages']): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    // Replay Anthropic's own content unchanged (keeps thinking blocks valid).
    if (m.role === 'assistant' && m.raw?.provider === 'anthropic') {
      return { role: 'assistant', content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = m.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error };
    });
    return { role: m.role, content };
  });
}

export const anthropicAdapter: ProviderAdapter = {
  async chat(target: ModelTarget, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    // Only the workspace's stored key is used. baseURL and authToken are explicit so the SDK
    // never falls back to ANTHROPIC_* variables or local profiles from the server's own environment.
    if (!target.apiKey) throw new ModelError('No API key configured for Anthropic', false);
    const client = new Anthropic({ apiKey: target.apiKey, authToken: null, baseURL: target.baseUrl || 'https://api.anthropic.com', maxRetries: 0, timeout: 600_000 });
    const useFallbacks = FALLBACK_MODELS.has(target.model);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: target.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: toParams(req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      ...(target.effort && EFFORTS.has(target.effort) ? { output_config: { effort: target.effort as 'medium' } } : {}),
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await client.beta.messages.create(params, { signal });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        const status = e.status ?? 0;
        throw new ModelError(`Anthropic ${status}: ${e.message}`, status === 0 || retryableStatus(status), status);
      }
      throw new ModelError(`Anthropic request failed: ${(e as Error).message}`, true);
    }
    const content: Block[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
    const sr = msg.stop_reason;
    return {
      content,
      raw: msg.content,
      stopReason: sr === 'end_turn' || sr === 'tool_use' || sr === 'max_tokens' || sr === 'refusal' ? sr : 'other',
      usage: {
        inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens ?? 0,
      },
      model: msg.model,
    };
  },
};
