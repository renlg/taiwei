import type { AgentContext } from './context.js';
import { resolveCompressThreshold, resolveContextWindow, type TaiweiConfig } from '../config/config.js';
import { streamChat } from '../llm/client.js';
import type { ChatMessage, TokenUsage } from '../llm/client.js';
import { toOpenAITool } from '../llm/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmationHandler } from '../security/commands.js';
import type { HookRunner } from '../hooks/runner.js';
import { MemoryStore } from '../memory/store.js';
import type { AgentProfile } from '../agents/profiles.js';

export interface RunTurnOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void;
  cwd?: string;
  retainConversation?: boolean;
  onEvent?: (event: AgentEvent) => void;
  getModel?: () => Promise<string>;
  confirmDanger?: ConfirmationHandler;
  authorizeCommand?: (command: string, cwd: string, handler?: ConfirmationHandler, signal?: AbortSignal) => Promise<boolean>;
  hooks?: HookRunner;
  sessionId?: string;
  agentProfile?: AgentProfile;
  delegationDepth?: number;
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'usage'; usage: TokenUsage & { contextWindow: number }; model: string }
  | { type: 'done'; text: string };

const COMPRESSION_PROMPT = 'Compress the following conversation history into a concise factual summary preserving key facts, decisions, user preferences, file paths, and unresolved tasks. Output only the summary.';
const FLUSH_PROMPT = 'Extract ONLY durable, long-term-worthy facts from the conversation history: user preferences, personal facts, project decisions, file paths, conventions, recurring constraints, and tasks the user wants remembered. Exclude transient chatter, greetings, and one-off questions with no lasting value. Avoid facts already present in the supplied memory tail. Output plain text lines with no markdown headers or JSON wrapper. If nothing is worth remembering, output exactly NO_MEMORY.';
const NO_MEMORY = 'NO_MEMORY';
const MEMORY_FLUSH_TAIL_CHARS = 800;
const MEMORY_FLUSH_MAX_CHARS = 60 * 1024;
const FLUSH_TOOL_RESULT_CHARS = 2_000;

function compressionBoundary(conversation: ChatMessage[]): number {
  const retainedCount = Math.max(20, Math.ceil(conversation.length / 3));
  const latestBoundary = conversation.length - retainedCount;
  if (latestBoundary <= 0) return 0;
  for (let index = latestBoundary; index > 0; index -= 1) {
    if (conversation[index]?.role === 'user' && conversation.slice(0, index).some((message) => message.role === 'assistant')) return index;
  }
  return 0;
}

function renderHistory(messages: ChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return `assistant: ${message.content ?? ''}\ntool calls: ${JSON.stringify(message.tool_calls)}`;
    }
    if (message.role === 'tool') return `tool (${message.name ?? message.tool_call_id}): ${message.content}`;
    return `${message.role}: ${message.content}`;
  }).join('\n\n');
}

function renderFlushHistory(messages: ChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === 'tool') {
      const content = message.content.length > FLUSH_TOOL_RESULT_CHARS
        ? `${message.content.slice(0, FLUSH_TOOL_RESULT_CHARS)}…[truncated]`
        : message.content;
      return `tool (${message.name ?? message.tool_call_id}): ${content}`;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return `assistant: ${message.content ?? ''}\ntool calls: ${JSON.stringify(message.tool_calls)}`;
    }
    return `${message.role}: ${message.content}`;
  }).join('\n');
}

async function flushMemory(
  conversation: ChatMessage[],
  boundary: number,
  config: TaiweiConfig,
  model: string,
  signal?: AbortSignal,
  memory = new MemoryStore(),
): Promise<boolean> {
  if (!boundary) return false;
  const memoryTail = (await memory.tail(MEMORY_FLUSH_TAIL_CHARS)).trim();
  const result = await streamChat({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    messages: [
      { role: 'system', content: FLUSH_PROMPT },
      {
        role: 'user',
        content: `Existing memory tail:\n${memoryTail || '(empty)'}\n\nHistory being discarded:\n${renderFlushHistory(conversation.slice(0, boundary))}`,
      },
    ],
    tools: [],
    signal,
    timeoutMs: 60_000,
  });
  const durableMemory = result.content.trim();
  if (!durableMemory || durableMemory === NO_MEMORY) return false;
  await memory.append(`## flushed ${new Date().toISOString()}\n${durableMemory}`, MEMORY_FLUSH_MAX_CHARS);
  return true;
}

async function compressConversation(
  conversation: ChatMessage[],
  boundary: number,
  config: TaiweiConfig,
  model: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!boundary) return false;
  const result = await streamChat({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    messages: [{ role: 'system', content: COMPRESSION_PROMPT }, { role: 'user', content: renderHistory(conversation.slice(0, boundary)) }],
    tools: [],
    signal,
    timeoutMs: 60_000,
  });
  const summary = result.content.trim();
  if (!summary) return false;
  conversation.splice(0, boundary, {
    role: 'system',
    content: `Conversation summary (history compressed at ${new Date().toISOString()}):\n${summary}`,
  });
  return true;
}

export async function runAgentTurn(
  prompt: string,
  context: AgentContext,
  registry: ToolRegistry,
  config: TaiweiConfig,
  options: RunTurnOptions = {},
): Promise<string> {
  const conversation = options.retainConversation === false ? [] : context.messages;
  if (options.agentProfile) context.profile = options.agentProfile;
  conversation.push({ role: 'user', content: prompt });
  let fullText = '';
  let compressionAttempted = false;
  const maxTurns = options.agentProfile?.maxTurns ?? config.maxTurns;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
    const model = options.getModel ? await options.getModel() : config.model;
    const systemPrompt = await context.systemPrompt(options.cwd, config.customPrompt);
    const lastMessage = conversation.at(-1);
    const lastMessagePreview = typeof lastMessage?.content === 'string' ? lastMessage.content.slice(0, 500) : '';
    const beforeLLM = await options.hooks?.run('beforeLLM', {
      sessionId: options.sessionId, model, messagesCount: conversation.length,
      lastMessagePreview,
    });
    const result = await streamChat({
      baseUrl: config.baseUrl, apiKey: config.apiKey, model,
      messages: [{ role: 'system', content: beforeLLM?.extraContext ? `${systemPrompt}\n\n${beforeLLM.extraContext}` : systemPrompt }, ...conversation],
      tools: registry.list({ profile: options.agentProfile }).map(({ name, description, parameters }) => toOpenAITool({ name, description, parameters })),
      signal: options.signal, timeoutMs: config.requestTimeoutMs,
      onText: (text) => {
        fullText += text;
        options.onText?.(text);
        options.onEvent?.({ type: 'token', text });
      },
    });
    await options.hooks?.run('afterLLM', {
      sessionId: options.sessionId, model, contentPreview: result.content.slice(0, 500),
      ...(result.usage ? { usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } } : {}),
    });
    if (result.usage) {
      const contextWindow = resolveContextWindow(config, model);
      options.onEvent?.({ type: 'usage', usage: { ...result.usage, contextWindow }, model });
      if (!compressionAttempted && result.usage.promptTokens > contextWindow * resolveCompressThreshold(config)) {
        compressionAttempted = true;
        const boundary = compressionBoundary(conversation);
        if (config.memoryFlush) {
          try { await flushMemory(conversation, boundary, config, model, options.signal, context.memory); }
          catch (error) {
            if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
            console.debug(`[taiwei] Memory flush skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try { await compressConversation(conversation, boundary, config, model, options.signal); }
        catch (error) {
          if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
          console.warn(`[taiwei] Conversation compression skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
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
      const cwd = options.cwd ?? process.cwd();
      output ??= await registry.dispatch(call.function.name, args, {
        signal: options.signal,
        cwd,
        agentContext: context,
        authorizeCommand: options.authorizeCommand
          ? (command, commandCwd) => options.authorizeCommand!(command, commandCwd, options.confirmDanger, options.signal)
          : undefined,
        hooks: options.hooks,
        sessionId: options.sessionId,
        agentProfile: options.agentProfile,
        delegationDepth: options.delegationDepth ?? 0,
      });
      options.onEvent?.({ type: 'tool_result', name: call.function.name, result: output });
      conversation.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output });
    }
  }
  throw new Error(`Agent stopped after reaching the ${maxTurns}-turn safety limit`);
}
