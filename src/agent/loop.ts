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
import { randomUUID } from 'node:crypto';
import { applyContextBudget, estimateTokens, limitTextTokens, limitToolsTokens } from './budget.js';
import { PolicyEngine } from '../security/policy.js';
import { appendAudit } from '../observability/audit.js';
import { emitEvent } from '../observability/events.js';
import { filterToolsForModel, resolveModel } from '../llm/catalog.js';
import { selectionFor } from '../config/model.js';

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
  role?: 'admin' | 'guest';
  identity?: string;
  workspaceRoot?: string;
  runId?: string;
  policy?: PolicyEngine;
  providerId?: string;
  model?: string;
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'compressing' }
  | { type: 'usage'; usage: TokenUsage & { contextWindow: number }; model: string; compressed?: boolean }
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
  const runId = options.runId ?? randomUUID();
  const sessionId = options.sessionId ?? 'local';
  const startedAt = Date.now();
  const startEvent = { type: 'turn.start', runId, sessionId, agentId: options.agentProfile?.id, model: config.model, outcome: 'started' } as const;
  emitEvent(startEvent); await appendAudit(startEvent).catch(() => {});
  const conversation = options.retainConversation === false ? [] : context.messages;
  if (options.agentProfile) context.profile = options.agentProfile;
  conversation.push({ role: 'user', content: prompt });
  let fullText = '';
  let compressionAttempted = false;
  const maxTurns = options.agentProfile?.maxTurns ?? config.maxTurns;
  try { for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
    const model = options.model ?? (options.getModel ? await options.getModel() : config.model);
    const selection = selectionFor(config, options.providerId, model);
    const resolved = resolveModel(config.providers.length ? config.providers : [{
      id: 'default', name: 'Default', type: 'openai-compatible', baseUrl: config.baseUrl, apiKey: config.apiKey, defaultModel: config.model,
      models: [{ id: model, provider: 'default', displayName: model, capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: resolveContextWindow(config, model) } }],
    }], selection);
    let systemPrompt = limitTextTokens(await context.systemPrompt(options.workspaceRoot ?? options.cwd, config.customPrompt), config.budget.systemMax, config.tokenEstimateCharsPerToken);
    const availableTools = registry.list({ profile: options.agentProfile }).map(({ name, description, parameters }) => toOpenAITool({ name, description, parameters }));
    const tools = limitToolsTokens(filterToolsForModel(availableTools, resolved.model), config.budget.toolsMax, config.tokenEstimateCharsPerToken);
    const contextWindow = resolved.model.capabilities.contextWindow || resolveContextWindow(config, model);
    let budgetResult = applyContextBudget(conversation, systemPrompt, tools, contextWindow, config.budget, config.tokenEstimateCharsPerToken);
    const compressionThreshold = contextWindow * resolveCompressThreshold(config);
    let compressedThisRequest = false;
    if (!compressionAttempted && (budgetResult.needsCompression || budgetResult.estimatedTokens > compressionThreshold)) {
      const boundary = compressionBoundary(conversation);
      if (boundary) {
        compressionAttempted = true;
        options.onEvent?.({ type: 'compressing' });
        if (config.memoryFlush) {
          try { await flushMemory(conversation, boundary, config, model, options.signal, context.memory); }
          catch (error) { if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError'); console.debug(`[taiwei] Memory flush skipped: ${error instanceof Error ? error.message : String(error)}`); }
        }
        try { compressedThisRequest = await compressConversation(conversation, boundary, config, model, options.signal); }
        catch (error) { if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError'); console.warn(`[taiwei] Conversation compression skipped: ${error instanceof Error ? error.message : String(error)}`); }
      }
      budgetResult = applyContextBudget(conversation, systemPrompt, tools, contextWindow, config.budget, config.tokenEstimateCharsPerToken);
    }
    const lastMessage = conversation.at(-1);
    const lastMessagePreview = typeof lastMessage?.content === 'string' ? lastMessage.content.slice(0, 500) : '';
    const beforeLLM = await options.hooks?.run('beforeLLM', {
      sessionId: options.sessionId, model, messagesCount: conversation.length,
      lastMessagePreview,
    });
    if (beforeLLM?.extraContext) systemPrompt = limitTextTokens(`${systemPrompt}\n\n${beforeLLM.extraContext}`, config.budget.systemMax, config.tokenEstimateCharsPerToken);
    const result = await streamChat({
      baseUrl: resolved.provider.baseUrl, apiKey: resolved.provider.apiKey ?? '', model,
      provider: resolved.provider,
      messages: [{ role: 'system', content: systemPrompt }, ...conversation],
      tools,
      signal: options.signal, timeoutMs: config.requestTimeoutMs,
      fallbackModel: config.fallbackModel,
      retry: config.retry,
      onAttempt: (attempt) => {
        const event = { type: attempt.outcome === 'fallback' ? 'model.fallback' : 'model.attempt', runId, sessionId, agentId: options.agentProfile?.id, model: attempt.model, retryAttempt: attempt.attempt, outcome: attempt.outcome, ...(attempt.delayMs === undefined ? {} : { backoffMs: attempt.delayMs }) } as const;
        emitEvent(event); void appendAudit(event).catch(() => {});
      },
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
    const promptTokens = result.usage?.promptTokens && result.usage.promptTokens > 0
      ? result.usage.promptTokens
      : budgetResult.estimatedTokens;
    if (!compressionAttempted && promptTokens > compressionThreshold) {
        const boundary = compressionBoundary(conversation);
        if (boundary) {
          compressionAttempted = true;
          options.onEvent?.({ type: 'compressing' });
          if (config.memoryFlush) {
            try { await flushMemory(conversation, boundary, config, model, options.signal, context.memory); }
            catch (error) {
              if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
              console.debug(`[taiwei] Memory flush skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          try { compressedThisRequest = await compressConversation(conversation, boundary, config, model, options.signal); }
          catch (error) {
            if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
            console.warn(`[taiwei] Conversation compression skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (compressedThisRequest) budgetResult = applyContextBudget(conversation, systemPrompt, tools, contextWindow, config.budget, config.tokenEstimateCharsPerToken);
        }
    }
    const reportedPromptTokens = compressedThisRequest ? budgetResult.estimatedTokens : promptTokens;
    const completionTokens = result.usage?.completionTokens ?? estimateTokens(result.content, config.tokenEstimateCharsPerToken);
    options.onEvent?.({
      type: 'usage',
      usage: { promptTokens: reportedPromptTokens, completionTokens, totalTokens: reportedPromptTokens + completionTokens, contextWindow },
      model,
      ...(compressedThisRequest ? { compressed: true } : {}),
    });
    conversation.push({ role: 'assistant', content: result.content || null, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
    if (!result.toolCalls.length) {
      const text = fullText || result.content;
      options.onEvent?.({ type: 'done', text });
      const endEvent = { type: 'turn.end', runId, sessionId, agentId: options.agentProfile?.id, model: result.model ?? model, latencyMs: Date.now() - startedAt, usage: result.usage, outcome: 'success' } as const;
      emitEvent(endEvent); await appendAudit(endEvent).catch(() => {});
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
          ? async (command, commandCwd) => {
            const approved = await options.authorizeCommand!(command, commandCwd, options.confirmDanger, options.signal);
            await appendAudit({ type: 'confirmation', runId, sessionId, agentId: options.agentProfile?.id, tool: 'bash', outcome: approved ? 'approved' : 'denied', command, cwd: commandCwd }).catch(() => {});
            return approved;
          }
          : undefined,
        hooks: options.hooks,
        sessionId: options.sessionId,
        agentProfile: options.agentProfile,
        delegationDepth: options.delegationDepth ?? 0,
        role: options.role,
        identity: options.identity,
        workspaceRoot: options.workspaceRoot ?? cwd,
        runId,
        policy: options.policy,
      });
      options.onEvent?.({ type: 'tool_result', name: call.function.name, result: output });
      conversation.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output });
    }
  }
  throw new Error(`Agent stopped after reaching the ${maxTurns}-turn safety limit`); }
  catch (error) {
    const endEvent = { type: 'turn.end', runId, sessionId, agentId: options.agentProfile?.id, model: config.model, latencyMs: Date.now() - startedAt, outcome: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error) } as const;
    emitEvent(endEvent); await appendAudit(endEvent).catch(() => {});
    throw error;
  }
}
