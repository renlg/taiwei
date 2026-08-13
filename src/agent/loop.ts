import type { AgentContext } from './context.js';
import type { TaiweiConfig } from '../config/config.js';
import { streamChat } from '../llm/client.js';
import type { TokenUsage } from '../llm/client.js';
import { toOpenAITool } from '../llm/tools.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface RunTurnOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void;
  cwd?: string;
  retainConversation?: boolean;
  onEvent?: (event: AgentEvent) => void;
  getModel?: () => Promise<string>;
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'usage'; usage: TokenUsage; model: string }
  | { type: 'done'; text: string };

export async function runAgentTurn(
  prompt: string,
  context: AgentContext,
  registry: ToolRegistry,
  config: TaiweiConfig,
  options: RunTurnOptions = {},
): Promise<string> {
  const conversation = options.retainConversation === false ? [] : context.messages;
  conversation.push({ role: 'user', content: prompt });
  let fullText = '';
  for (let turn = 0; turn < config.maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
    const model = options.getModel ? await options.getModel() : config.model;
    const result = await streamChat({
      baseUrl: config.baseUrl, apiKey: config.apiKey, model,
      messages: [{ role: 'system', content: await context.systemPrompt() }, ...conversation],
      tools: registry.list().map(({ name, description, parameters }) => toOpenAITool({ name, description, parameters })),
      signal: options.signal, timeoutMs: config.requestTimeoutMs,
      onText: (text) => {
        fullText += text;
        options.onText?.(text);
        options.onEvent?.({ type: 'token', text });
      },
    });
    if (result.usage) options.onEvent?.({ type: 'usage', usage: result.usage, model });
    conversation.push({ role: 'assistant', content: result.content || null, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
    if (!result.toolCalls.length) {
      const text = fullText || result.content;
      options.onEvent?.({ type: 'done', text });
      return text;
    }
    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {};
      let output: string;
      try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; }
      catch (error) { output = JSON.stringify({ error: `Invalid tool arguments: ${(error as Error).message}` }); }
      options.onEvent?.({ type: 'tool', name: call.function.name, args });
      output ??= await registry.dispatch(call.function.name, args, { signal: options.signal, cwd: options.cwd ?? process.cwd() });
      options.onEvent?.({ type: 'tool_result', name: call.function.name, result: output });
      conversation.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output });
    }
  }
  throw new Error(`Agent stopped after reaching the ${config.maxTurns}-turn safety limit`);
}
