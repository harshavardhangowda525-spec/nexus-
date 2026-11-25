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

function compactForGroq(messages: any[], tools: any[], maxBudget = 7400): { messages: any[]; maxCompletion: number } {
  const est = (m: any[]) => Math.ceil((JSON.stringify(m).length + JSON.stringify(tools).length) / 3.5);
  let msgs = messages.map((m) => ({ ...m }));
  if (est(msgs) > 5400) {
    // Trim older tool outputs first, preserving the latest 2 messages in full.
    msgs = msgs.map((m, i) => {
      if (i >= msgs.length - 2 || typeof m.content !== 'string') return m;
      if (m.role === 'tool' && m.content.length > 600) {
        return { ...m, content: m.content.slice(0, 600) + '\n[earlier tool output compacted for TPM budget]' };
      }
      if (m.role === 'user' && m.content.length > 1500) {
        return { ...m, content: m.content.slice(0, 1500) + '\n[compacted]' };
      }
      return m;
    });
  }
  // If still over budget, drop oldest middle turns (keeping system + initial user prompt + last 4 turns).
  while (msgs.length > 6 && est(msgs) > 5800) {
    msgs.splice(2, 2);
  }
  const used = est(msgs);
  const maxCompletion = Math.max(400, Math.min(2048, maxBudget - used));
  return { messages: msgs, maxCompletion };
}

export function openaiCompatibleAdapter(defaultBase: string, needsKey: boolean): ProviderAdapter {
  return {
    async chat(target: ModelTarget, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      if (needsKey && !target.apiKey) throw new ModelError('No API key configured for this provider', false);
      const base = (target.baseUrl || defaultBase).replace(/\/+$/, '');
      const isGroq = /api\.groq\.com/i.test(base);
      const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      let messages = toOpenAIMessages(req);
      let maxTokens = req.maxTokens ?? 16000;
      if (isGroq) {
        const compacted = compactForGroq(messages, tools, /qwen/i.test(target.model) ? 6500 : 7400);
        messages = compacted.messages;
        const groqCap = /qwen/i.test(target.model) ? Math.min(compacted.maxCompletion, 800) : compacted.maxCompletion;
        maxTokens = req.maxTokens ? Math.min(req.maxTokens, groqCap) : groqCap;
      }
      const body = {
        model: target.model,
        messages,
        tools,
        max_completion_tokens: maxTokens,
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
      if (!res.ok) {
        const ra = Number(res.headers.get('retry-after'));
        const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : undefined;
        throw new ModelError(`HTTP ${res.status}: ${text.slice(0, 400)}`, retryableStatus(res.status), res.status, retryAfterMs);
      }
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
