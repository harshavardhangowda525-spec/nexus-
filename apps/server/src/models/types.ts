import type { ProviderKind } from '@nexus/shared';

/**
 * Provider-neutral conversation format used by the agent runner.
 * Assistant turns also keep the provider's raw content (`raw`) so that
 * provider-specific blocks (Anthropic thinking blocks, Gemini thought
 * signatures) are replayed unchanged on the next request to that provider.
 */
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: Block[];
  raw?: { provider: ProviderKind; content: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export interface Usage { inputTokens: number; outputTokens: number }

export interface ChatResponse {
  content: Block[];
  raw: unknown;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: Usage;
  model: string;
}

export interface ModelTarget {
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  baseUrl?: string | null;
  effort?: string | null;
}

export interface ProviderAdapter {
  chat(target: ModelTarget, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

/** Thrown by adapters. `retryable` drives the gateway's backoff policy. */
export class ModelError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export function retryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
