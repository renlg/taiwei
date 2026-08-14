import type { ChatMessage, ChatResult, TokenUsage, ToolCall } from '../client.js';
import { parseRetryAfter, ProviderHttpError } from '../retry.js';
import type { ProviderAdapter, ProviderRequest } from './types.js';

interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; }
interface AnthropicPayload { content?: AnthropicBlock[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number }; model?: string; }

export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const mapped: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content } as unknown as AnthropicBlock;
      const previous = mapped.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(block);
      else mapped.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      blocks.push(...message.tool_calls.map((call) => ({
        type: 'tool_use', id: call.id, name: call.function.name,
        input: parseArguments(call.function.arguments),
      })));
      mapped.push({ role: 'assistant', content: blocks });
    } else mapped.push({ role: message.role, content: message.content ?? '' });
  }
  return { ...(system ? { system } : {}), messages: mapped };
}

function parseArguments(value: string): Record<string, unknown> {
  try { return JSON.parse(value || '{}') as Record<string, unknown>; } catch { return {}; }
}

export function fromAnthropicResponse(payload: AnthropicPayload, onText?: (text: string) => void): ChatResult {
  const text = (payload.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
  if (text) onText?.(text);
  const toolCalls: ToolCall[] = (payload.content ?? []).filter((block) => block.type === 'tool_use').map((block) => ({
    id: block.id ?? '', type: 'function', function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
  }));
  const input = payload.usage?.input_tokens ?? 0; const output = payload.usage?.output_tokens ?? 0;
  const usage: TokenUsage | undefined = payload.usage ? { promptTokens: input, completionTokens: output, totalTokens: input + output } : undefined;
  return { content: text, toolCalls, usage, model: payload.model };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'anthropic' as const;
  async stream(request: ProviderRequest): Promise<ChatResult> {
    const mapped = toAnthropicMessages(request.messages);
    const response = await fetch(`${request.provider.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST', signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? 120_000)]) : AbortSignal.timeout(request.timeoutMs ?? 120_000),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(request.provider.apiKey ? { 'x-api-key': request.provider.apiKey } : {}) },
      body: JSON.stringify({ model: request.model, max_tokens: 4096, ...mapped, tools: request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new ProviderHttpError(response.status, `Anthropic request failed (${response.status}): ${body.slice(0, 500)}`, parseRetryAfter(response.headers.get('retry-after')));
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Anthropic streaming is not yet supported by this best-effort adapter; use a JSON response endpoint');
    return fromAnthropicResponse(await response.json() as AnthropicPayload, request.onText);
  }
}
