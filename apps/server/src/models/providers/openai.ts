import type { Block, ChatRequest, ChatResponse, ModelTarget, ProviderAdapter } from '../types.js';
import { ModelError, retryableStatus } from '../types.js';

/** OpenAI-compatible Chat Completions. Also used for Ollama's /v1 endpoint. */
export function toOpenAIMessages(req: ChatRequest) {
  const out: any[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use') as any[];
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
      });
    } else {
      const results = m.content.filter((b) => b.type === 'tool_result') as any[];
      for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.is_error ? `ERROR: ${r.content}` : r.content });
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export function openaiCompatibleAdapter(defaultBase: string, needsKey: boolean): ProviderAdapter {
  return {
    async chat(target: ModelTarget, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      if (needsKey && !target.apiKey) throw new ModelError('No API key configured for this provider', false);
      const base = (target.baseUrl || defaultBase).replace(/\/+$/, '');
      const body = {
        model: target.model,
        messages: toOpenAIMessages(req),
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        max_completion_tokens: req.maxTokens ?? 16000,
      };
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        throw new ModelError(`Request to ${base} failed: ${(e as Error).message}`, true);
      }
      const text = await res.text();
      if (!res.ok) throw new ModelError(`HTTP ${res.status}: ${text.slice(0, 400)}`, retryableStatus(res.status), res.status);
      let data: any;
      try { data = JSON.parse(text); } catch { throw new ModelError('Provider returned invalid JSON', true); }
      const choice = data.choices?.[0];
      if (!choice) throw new ModelError('Provider returned no choices', true);
      const content: Block[] = [];
      if (choice.message?.content) content.push({ type: 'text', text: String(choice.message.content) });
      for (const tc of choice.message?.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = { __invalid_json: tc.function?.arguments }; }
        content.push({ type: 'tool_use', id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name, input });
      }
      const fr = choice.finish_reason;
      const hasTools = content.some((b) => b.type === 'tool_use');
      return {
        content,
        raw: choice.message,
        stopReason: hasTools ? 'tool_use' : fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'refusal' : 'end_turn',
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
        model: data.model || target.model,
      };
    },
  };
}
