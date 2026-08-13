import type { OpenAIToolSchema } from './tools.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export interface ChatResult { content: string; toolCalls: ToolCall[]; }

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: OpenAIToolSchema[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onText?: (text: string) => void;
}

function friendlyProviderError(status: number, body: string): Error {
  const detail = (() => { try { return JSON.parse(body).error?.message as string; } catch { return body.slice(0, 500); } })();
  if (status === 429) return new Error(`Provider rate limit reached (429): ${detail}`);
  if (status >= 500) return new Error(`Provider is temporarily unavailable (${status}): ${detail}`);
  return new Error(`Provider request failed (${status}): ${detail}`);
}

export async function streamChat(request: ChatRequest): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const response = await fetch(`${request.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}) },
    body: JSON.stringify({ model: request.model, messages: request.messages, tools: request.tools, stream: true }),
  });
  if (!response.ok) throw friendlyProviderError(response.status, await response.text());
  if (response.headers.get('content-type')?.includes('application/json')) {
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned a malformed completion');
    const content = message.content ?? '';
    if (content) request.onText?.(content);
    return { content, toolCalls: message.tool_calls ?? [] };
  }
  if (!response.body) throw new Error('Provider returned an empty response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
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
      let payload: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }> } }> };
      try { payload = JSON.parse(data) as typeof payload; } catch { continue; }
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
  return { content, toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) };
}
