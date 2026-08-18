import type { OpenAIToolSchema } from './tools.js';
import { parseRetryAfter, ProviderHttpError, retryableProviderError, withProviderRetry, type RetryOptions } from './retry.js';
import type { ProviderConfig } from './providers/types.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type UserContent = string | ContentBlock[];

export type ChatMessage =
  | { role: 'system' | 'user'; content: UserContent }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!message.content) return '';
  return message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map((block) => block.text).join('');
}

export function hasVisionContent(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'image_url');
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult { content: string; toolCalls: ToolCall[]; usage?: TokenUsage; model?: string; attempts?: number; }

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: OpenAIToolSchema[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onText?: (text: string) => void;
  fallbackModel?: string;
  retry?: Omit<RetryOptions, 'onRetry'>;
  onAttempt?: (event: { model: string; attempt: number; delayMs?: number; outcome: 'start' | 'retry' | 'success' | 'fallback' }) => void;
  provider?: ProviderConfig;
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function normalizeUsage(usage?: ProviderUsage): TokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = Number.isFinite(usage.prompt_tokens) ? Math.max(0, usage.prompt_tokens ?? 0) : 0;
  const completionTokens = Number.isFinite(usage.completion_tokens) ? Math.max(0, usage.completion_tokens ?? 0) : 0;
  const totalTokens = Number.isFinite(usage.total_tokens) ? Math.max(0, usage.total_tokens ?? 0) : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function friendlyProviderError(status: number, body: string, retryAfter?: string | null): Error {
  const detail = (() => { try { return JSON.parse(body).error?.message as string; } catch { return body.slice(0, 500); } })();
  const message = status === 429 ? `Provider rate limit reached (429): ${detail}`
    : status >= 500 ? `Provider is temporarily unavailable (${status}): ${detail}`
      : `Provider request failed (${status}): ${detail}`;
  return new ProviderHttpError(status, message, parseRetryAfter(retryAfter ?? null));
}

async function streamChatOnce(request: ChatRequest, model: string): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const response = await fetch(`${request.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: request.messages,
      tools: request.tools,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) throw friendlyProviderError(response.status, await response.text(), response.headers.get('retry-after'));
  if (response.headers.get('content-type')?.includes('application/json')) {
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
      usage?: ProviderUsage;
    };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned a malformed completion');
    const content = message.content ?? '';
    if (content) request.onText?.(content);
    return { content, toolCalls: message.tool_calls ?? [], usage: normalizeUsage(payload.usage), model };
  }
  if (!response.body) throw new Error('Provider returned an empty response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: TokenUsage | undefined;
  const calls = new Map<number, ToolCall>();
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let payload: {
        choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }> } }>;
        usage?: ProviderUsage;
      };
      try { payload = JSON.parse(data) as typeof payload; } catch { continue; }
      usage = normalizeUsage(payload.usage) ?? usage;
      const delta = payload.choices?.[0]?.delta;
      if (delta?.content) { content += delta.content; request.onText?.(delta.content); }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: part.id ?? '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
    }
    if (done) break;
  }
  return { content, toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), usage, model };
}

export async function openAICompatibleStream(request: ChatRequest): Promise<ChatResult> {
  const retry = request.retry ?? { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 30_000 };
  const runModel = async (model: string) => withProviderRetry(async (attempt) => {
    request.onAttempt?.({ model, attempt, outcome: 'start' });
    const value = await streamChatOnce(request, model);
    request.onAttempt?.({ model, attempt, outcome: 'success' });
    return value;
  }, {
    ...retry,
    onRetry: (attempt, delayMs) => request.onAttempt?.({ model, attempt, delayMs, outcome: 'retry' }),
  });
  try {
    const result = await runModel(request.model);
    return { ...result.value, attempts: result.attempts };
  } catch (error) {
    if (!request.fallbackModel || request.fallbackModel === request.model || !retryableProviderError(error)) throw error;
    request.onAttempt?.({ model: request.fallbackModel, attempt: 1, outcome: 'fallback' });
    const result = await streamChatOnce(request, request.fallbackModel);
    return { ...result, attempts: retry.maxAttempts + 1 };
  }
}

export async function streamChat(request: ChatRequest): Promise<ChatResult> {
  if (!request.provider || request.provider.type === 'openai-compatible') return openAICompatibleStream(request);
  const { providerAdapter } = await import('./providers/index.js');
  return providerAdapter(request.provider.type).stream({
    provider: request.provider, model: request.model, messages: request.messages, tools: request.tools,
    signal: request.signal, timeoutMs: request.timeoutMs, onText: request.onText,
    fallbackModel: request.fallbackModel, retry: request.retry, onAttempt: request.onAttempt,
  });
}
