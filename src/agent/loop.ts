import type { AgentContext } from './context.js';
import { resolveCompressThreshold, resolveContextWindow, type TaiweiConfig } from '../config/config.js';
import { messageText, repairToolCallArguments, streamChat, type ChatMessage, type ChatResult, type ContentBlock, type TokenUsage } from '../llm/client.js';
import { toOpenAITool } from '../llm/tools.js';
import type { TenantIdentity, ToolRegistry } from '../tools/registry.js';
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
import { ProviderHttpError } from '../llm/retry.js';
import { guestIdForUsername } from '../util/paths.js';
import { parseSkill } from '../skills/loader.js';
import { UserSkillStore } from '../skills/user-store.js';
import { DiagnosticFeedbackSession, formatDiagnostic } from '../lsp/diagnostics.js';

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
  guestId?: string;
  tenantIdentity?: TenantIdentity;
  workspaceRoot?: string;
  runId?: string;
  policy?: PolicyEngine;
  providerId?: string;
  model?: string;
  userContent?: ContentBlock[];
  userSkillStore?: UserSkillStore;
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'model_iterate'; model: string; feedbackAttempt: number; maxFeedbackIterations: number; error: ModelErrorFeedback }
  | { type: 'compressing' }
  | { type: 'usage'; usage: TokenUsage & { contextWindow: number }; model: string; compressed?: boolean }
  | { type: 'done'; text: string };

const COMPRESSION_PROMPT = 'Compress the following conversation history into a concise factual summary preserving key facts, decisions, user preferences, file paths, and unresolved tasks. Output only the summary.';
const FLUSH_PROMPT = 'Extract ONLY durable, long-term-worthy facts from the conversation history: user preferences, personal facts, project decisions, file paths, conventions, recurring constraints, and tasks the user wants remembered. Exclude transient chatter, greetings, and one-off questions with no lasting value. Avoid facts already present in the supplied memory tail. Output plain text lines with no markdown headers or JSON wrapper. If nothing is worth remembering, output exactly NO_MEMORY.';
const NO_MEMORY = 'NO_MEMORY';
const MEMORY_FLUSH_TAIL_CHARS = 800;
const MEMORY_FLUSH_MAX_CHARS = 60 * 1024;
const FLUSH_TOOL_RESULT_CHARS = 2_000;
const SKILL_SELF_LEARNING_MAX_CHARS = 80 * 1024;
const NO_SKILL = 'NO_SKILL';
const SKILL_SELF_LEARNING_PROMPT = `Review the supplied conversation and decide whether it contains a reusable multi-step workflow worth saving as a skill. Good candidates include repeated tool-driven procedures, a discovered platform API workflow, or standard deployment/project steps. Do not create a skill for one-off facts, trivial answers, incomplete/failed work, or generic advice. If there is no strong candidate, output exactly NO_SKILL. Otherwise output only one complete SKILL.md: YAML frontmatter with a lowercase filesystem-safe name (1-64 letters, numbers, hyphens, or underscores) and a specific description, followed by actionable steps, checks, pitfalls, and reusable commands with conversation-specific secrets removed. Do not wrap it in a code fence.`;

interface ModelErrorFeedback {
  message: string;
  status?: number;
  retryAfterMs?: number;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function modelErrorFeedback(error: unknown): ModelErrorFeedback {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderHttpError) {
    return {
      message,
      status: error.status,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  const candidate = error && typeof error === 'object'
    ? error as { status?: unknown; statusCode?: unknown; retryAfterMs?: unknown }
    : {};
  const status = typeof candidate.status === 'number' ? candidate.status
    : typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
  const retryAfterMs = typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs : undefined;
  return { message, ...(status === undefined ? {} : { status }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

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
    return `${message.role}: ${messageText(message)}`;
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
    return `${message.role}: ${messageText(message)}`;
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

async function distillUserSkill(
  conversation: ChatMessage[],
  config: TaiweiConfig,
  model: string,
  owner: string,
  signal?: AbortSignal,
  store = new UserSkillStore(),
): Promise<boolean> {
  const history = renderFlushHistory(conversation);
  const result = await streamChat({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.skillSelfLearningModel?.trim() || model,
    messages: [
      { role: 'system', content: SKILL_SELF_LEARNING_PROMPT },
      { role: 'user', content: `Conversation history:\n${history.length > SKILL_SELF_LEARNING_MAX_CHARS ? history.slice(-SKILL_SELF_LEARNING_MAX_CHARS) : history}` },
    ],
    tools: [],
    signal,
    timeoutMs: 60_000,
  });
  const content = result.content.trim();
  if (!content || content === NO_SKILL) return false;
  const parsed = parseSkill(content, 'distilled SKILL.md');
  const saved = await store.save(owner, parsed.name, content);
  if (saved.created) console.log(`[taiwei] Learned user skill "${saved.name}" for ${owner}`);
  return saved.created;
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
  conversation.push({ role: 'user', content: options.userContent?.length ? options.userContent : prompt });
  // This snapshot shares immutable message objects with conversation. New messages must be
  // appended to both arrays below so conversation compression cannot discard distillation input.
  const selfLearningConversation = [...conversation];
  let fullText = '';
  let compressionAttempted = false;
  let consecutiveModelFeedbacks = 0;
  const configuredFeedbackIterations = config.retry.maxFeedbackIterations;
  const maxFeedbackIterations = Number.isFinite(configuredFeedbackIterations)
    ? Math.max(0, Math.floor(configuredFeedbackIterations))
    : 2;
  const maxTurns = options.agentProfile?.maxTurns ?? config.maxTurns;
  const diagnostics = options.role !== 'guest' && config.lsp.enabled && config.lsp.autoInject
    ? new DiagnosticFeedbackSession(options.workspaceRoot ?? options.cwd ?? process.cwd(), config.lsp.maxDiagnostics, options.signal)
    : undefined;
  try { for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');
    const model = options.model ?? (options.getModel ? await options.getModel() : config.model);
    const selection = selectionFor(config, options.providerId, model);
    const resolved = resolveModel(config.providers.length ? config.providers : [{
      id: 'default', name: 'Default', type: 'openai-compatible', baseUrl: config.baseUrl, apiKey: config.apiKey, defaultModel: config.model,
      models: [{ id: model, provider: 'default', displayName: model, capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: resolveContextWindow(config, model) } }],
    }], selection);
    let systemPrompt = limitTextTokens(await context.systemPrompt(options.workspaceRoot ?? options.cwd, config.customPrompt), config.budget.systemMax, config.tokenEstimateCharsPerToken);
    const diagnosticInjection = diagnostics?.takeInjection() ?? [];
    if (diagnosticInjection.length) {
      const feedback = `Current workspace diagnostics introduced by the file(s) just modified:\n${diagnosticInjection.map(formatDiagnostic).join('\n')}\nPrioritize fixing these new compile errors before continuing.`;
      systemPrompt = limitTextTokens(`${systemPrompt}\n\n${feedback}`, config.budget.systemMax, config.tokenEstimateCharsPerToken);
    }
    const availableTools = registry.list({ profile: options.agentProfile })
      .filter((tool) => options.role !== 'guest' || tool.name !== 'get_diagnostics')
      .map(({ name, description, parameters }) => toOpenAITool({ name, description, parameters }));
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
    const lastMessagePreview = messageText(lastMessage ?? { role: 'user', content: '' }).slice(0, 500);
    const beforeLLM = await options.hooks?.run('beforeLLM', {
      sessionId: options.sessionId, model, messagesCount: conversation.length,
      lastMessagePreview,
    });
    if (beforeLLM?.extraContext) systemPrompt = limitTextTokens(`${systemPrompt}\n\n${beforeLLM.extraContext}`, config.budget.systemMax, config.tokenEstimateCharsPerToken);
    let result: ChatResult;
    try {
      result = await streamChat({
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
    } catch (error) {
      if (isAbortError(error, options.signal) || consecutiveModelFeedbacks >= maxFeedbackIterations) throw error;
      consecutiveModelFeedbacks += 1;
      const feedback = modelErrorFeedback(error);
      const iterateEvent = {
        type: 'model.iterate', runId, sessionId, agentId: options.agentProfile?.id, model,
        retryAttempt: consecutiveModelFeedbacks, maxFeedbackIterations, outcome: 'feedback', error: feedback,
      } as const;
      emitEvent(iterateEvent); await appendAudit(iterateEvent).catch(() => {});
      options.onEvent?.({
        type: 'model_iterate', model, feedbackAttempt: consecutiveModelFeedbacks, maxFeedbackIterations, error: feedback,
      });
      conversation.push({
        role: 'user',
        content: JSON.stringify({
          type: 'llm_request_error',
          model,
          ...feedback,
          feedbackAttempt: consecutiveModelFeedbacks,
          maxFeedbackIterations,
          instruction: 'The previous upstream LLM request failed after provider retry/fallback handling. Use this feedback to choose the next step or explain the failure to the user.',
        }),
      });
      selfLearningConversation.push(conversation.at(-1)!);
      continue;
    }
    consecutiveModelFeedbacks = 0;
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
    const normalizedToolCalls = result.toolCalls.map((call) => {
      const repaired = repairToolCallArguments(call.function.arguments || '{}');
      return { call: { ...call, function: { ...call.function, arguments: repaired ?? '{}' } }, repaired };
    });
    conversation.push({ role: 'assistant', content: result.content || null, ...(normalizedToolCalls.length ? { tool_calls: normalizedToolCalls.map(({ call }) => call) } : {}) });
    selfLearningConversation.push(conversation.at(-1)!);
    if (!result.toolCalls.length) {
      const text = fullText || result.content;
      options.onEvent?.({ type: 'done', text });
      const endEvent = { type: 'turn.end', runId, sessionId, agentId: options.agentProfile?.id, model: result.model ?? model, latencyMs: Date.now() - startedAt, usage: result.usage, outcome: 'success' } as const;
      emitEvent(endEvent); await appendAudit(endEvent).catch(() => {});
      if (config.skillSelfLearning) {
        const owner = options.role === 'guest' ? options.guestId ?? guestIdForUsername(options.identity ?? 'guest') : 'admin';
        void distillUserSkill(selfLearningConversation, config, model, owner, undefined, options.userSkillStore)
          .catch((error) => console.debug(`[taiwei] Skill self-learning skipped: ${error instanceof Error ? error.message : String(error)}`));
      }
      return text;
    }
    for (const normalized of normalizedToolCalls) {
      const call = normalized.call;
      let args: Record<string, unknown> = {};
      let output: string;
      if (normalized.repaired === null) {
        output = JSON.stringify({ error: 'Invalid tool call arguments, please regenerate with valid JSON.' });
      } else {
        try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; }
        catch { output = JSON.stringify({ error: 'Invalid tool call arguments, please regenerate with valid JSON.' }); }
      }
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
        tenantIdentity: options.tenantIdentity,
        workspaceRoot: options.workspaceRoot ?? cwd,
        runId,
        policy: options.policy,
        lsp: config.lsp,
        beforeFileWrite: diagnostics ? async () => {
          try { await diagnostics.beforeWrite(); }
          catch (error) { if (options.signal?.aborted) throw error; console.debug(`[taiwei] Diagnostic baseline skipped: ${error instanceof Error ? error.message : String(error)}`); }
        } : undefined,
        afterFileWrite: diagnostics ? async (path) => {
          try { await diagnostics.afterWrite(path); }
          catch (error) { if (options.signal?.aborted) throw error; console.debug(`[taiwei] Diagnostic refresh skipped: ${error instanceof Error ? error.message : String(error)}`); }
        } : undefined,
      });
      options.onEvent?.({ type: 'tool_result', name: call.function.name, result: output });
      conversation.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: output });
      selfLearningConversation.push(conversation.at(-1)!);
    }
  }
  throw new Error(`Agent stopped after reaching the ${maxTurns}-turn safety limit`); }
  catch (error) {
    const endEvent = { type: 'turn.end', runId, sessionId, agentId: options.agentProfile?.id, model: config.model, latencyMs: Date.now() - startedAt, outcome: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error) } as const;
    emitEvent(endEvent); await appendAudit(endEvent).catch(() => {});
    throw error;
  }
}
