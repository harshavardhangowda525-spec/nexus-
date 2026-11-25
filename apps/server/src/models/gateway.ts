import type { ProviderKind } from '@nexus/shared';
import { anthropicAdapter } from './providers/anthropic.js';
import { geminiAdapter } from './providers/gemini.js';
import { openaiCompatibleAdapter } from './providers/openai.js';
import type { ChatRequest, ChatResponse, ModelTarget, ProviderAdapter } from './types.js';
import { ModelError } from './types.js';

export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
  ollama: 'llama3.1',
};

/** USD per 1M tokens [input, output]. Unknown models are recorded as unpriced, not as free. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-2': [8, 40], 'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};

export function priceFor(provider: ProviderKind, model: string, extra: Record<string, [number, number]> = {}) {
  if (provider === 'ollama') return { priced: true, input: 0, output: 0 };
  const p = extra[model] ?? PRICES[model];
  return p ? { priced: true, input: p[0], output: p[1] } : { priced: false, input: 0, output: 0 };
}

export function costOf(provider: ProviderKind, model: string, inTok: number, outTok: number, extra?: Record<string, [number, number]>) {
  const p = priceFor(provider, model, extra);
  return { priced: p.priced, usd: (inTok * p.input + outTok * p.output) / 1_000_000 };
}

export interface GatewayOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  adapters?: Partial<Record<ProviderKind, ProviderAdapter>>;
  extraPrices?: Record<string, [number, number]>;
}

export interface GatewayResult extends ChatResponse {
  costUsd: number;
  priced: boolean;
  durationMs: number;
  attempts: number;
}

/** Provider-agnostic entry point: retries transient failures with jittered exponential backoff. */
export class ModelGateway {
  private adapters: Record<ProviderKind, ProviderAdapter>;
  constructor(private opts: GatewayOptions = {}) {
    this.adapters = {
      anthropic: anthropicAdapter,
      openai: openaiCompatibleAdapter('https://api.openai.com/v1', true),
      gemini: geminiAdapter,
      ollama: openaiCompatibleAdapter('http://127.0.0.1:11434/v1', false),
      ...(opts.adapters ?? {}),
    };
  }

  async chat(target: ModelTarget, req: ChatRequest, signal?: AbortSignal): Promise<GatewayResult> {
    const maxRetries = this.opts.maxRetries ?? 3;
    const base = this.opts.baseDelayMs ?? 1000;
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt++;
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 600_000);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const r = await this.adapters[target.provider].chat(target, req, sig);
        const c = costOf(target.provider, target.model, r.usage.inputTokens, r.usage.outputTokens, this.opts.extraPrices);
        return { ...r, costUsd: c.usd, priced: c.priced, durationMs: Date.now() - started, attempts: attempt };
      } catch (e) {
        if (signal?.aborted) throw e;
        const err = e instanceof ModelError ? e : new ModelError((e as Error).message, true);
        const limit = err.status === 429 ? Math.max(maxRetries, 5) : maxRetries;
        if (!err.retryable || attempt > limit) throw err;
        const expDelay = base * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
        const delay = err.retryAfterMs ? Math.max(err.retryAfterMs, expDelay) : expDelay;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
