import type { Block, ChatRequest, ChatResponse, ModelTarget, ProviderAdapter } from '../types.js';
import { ModelError, retryableStatus } from '../types.js';

const ALLOWED_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable']);

/** Gemini accepts an OpenAPI subset; drop keys it rejects (additionalProperties, etc.). */
export function geminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (!ALLOWED_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else out[k] = geminiSchema(v);
  }
  return out;
}

export function toGeminiContents(req: ChatRequest) {
  const names = new Map<string, string>();
  const contents: any[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
      // Replay Gemini parts as returned (keeps thought signatures).
      if (m.raw?.provider === 'gemini') { contents.push({ role: 'model', parts: m.raw.content }); continue; }
      contents.push({
        role: 'model',
        parts: m.content.map((b) => (b.type === 'text' ? { text: b.text } : b.type === 'tool_use' ? { functionCall: { name: b.name, args: b.input } } : { text: '' })),
      });
    } else {
      const parts = m.content.map((b) => {
        if (b.type === 'tool_result') return { functionResponse: { name: names.get(b.tool_use_id) || 'tool', response: { [b.is_error ? 'error' : 'content']: b.content } } };
        if (b.type === 'text') return { text: b.text };
        return { text: '' };
      });
      contents.push({ role: 'user', parts });
    }
  }
  return contents;
}

export const geminiAdapter: ProviderAdapter = {
  async chat(target: ModelTarget, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (!target.apiKey) throw new ModelError('No API key configured for Gemini', false);
    const base = (target.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req),
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) })) }],
      generationConfig: { maxOutputTokens: req.maxTokens ?? 16000 },
    };
    let res: Response;
    try {
      res = await fetch(`${base}/v1beta/models/${encodeURIComponent(target.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': target.apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new ModelError(`Request to Gemini failed: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    if (!res.ok) throw new ModelError(`HTTP ${res.status}: ${text.slice(0, 400)}`, retryableStatus(res.status), res.status);
    const data = JSON.parse(text);
    const cand = data.candidates?.[0];
    if (!cand) {
      const reason = data.promptFeedback?.blockReason;
      if (reason) return { content: [], raw: [], stopReason: 'refusal', usage: { inputTokens: 0, outputTokens: 0 }, model: target.model };
      throw new ModelError('Gemini returned no candidates', true);
    }
    const parts: any[] = cand.content?.parts ?? [];
    const content: Block[] = [];
    parts.forEach((p, i) => {
      if (p.text && !p.thought) content.push({ type: 'text', text: p.text });
      if (p.functionCall) content.push({ type: 'tool_use', id: p.functionCall.id || `gem_${Date.now().toString(36)}_${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
    });
    const hasTools = content.some((b) => b.type === 'tool_use');
    const fr = cand.finishReason;
    return {
      content,
      raw: parts,
      stopReason: hasTools ? 'tool_use' : fr === 'MAX_TOKENS' ? 'max_tokens' : fr === 'SAFETY' || fr === 'PROHIBITED_CONTENT' ? 'refusal' : 'end_turn',
      usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0) },
      model: data.modelVersion || target.model,
    };
  },
};
