import type { ChatMessage } from '../llm/client.js';
import type { OpenAIToolSchema } from '../llm/tools.js';

export interface BudgetSettings { systemMax: number; historyMax: number; toolsMax: number; outputReserve: number; }
export interface BudgetResult { estimatedTokens: number; historyTokens: number; prunedChars: number; needsCompression: boolean; }

const toolResultSizeCache = new WeakMap<object, { content: string; tokens: number }>();

export function estimateTokens(value: string, charsPerToken = 4): number {
  return Math.ceil(value.length / Math.max(1, charsPerToken));
}

export function estimateMessages(messages: ChatMessage[], charsPerToken = 4): number {
  return messages.reduce((total, message) => {
    if (message.role === 'tool') {
      const cached = toolResultSizeCache.get(message);
      if (cached?.content === message.content) return total + cached.tokens;
      const tokens = estimateTokens(JSON.stringify(message), charsPerToken);
      toolResultSizeCache.set(message, { content: message.content, tokens });
      return total + tokens;
    }
    return total + estimateTokens(JSON.stringify(message), charsPerToken);
  }, 0);
}

export function limitTextTokens(value: string, maxTokens: number, charsPerToken = 4): string {
  if (estimateTokens(value, charsPerToken) <= maxTokens) return value;
  const marker = '\n[truncated to context budget]';
  return `${value.slice(0, Math.max(0, maxTokens * Math.max(1, charsPerToken) - marker.length))}${marker}`;
}

export function limitToolsTokens(tools: OpenAIToolSchema[], maxTokens: number, charsPerToken = 4): OpenAIToolSchema[] {
  const retained: OpenAIToolSchema[] = [];
  for (const tool of tools) {
    if (estimateTokens(JSON.stringify([...retained, tool]), charsPerToken) > maxTokens) break;
    retained.push(tool);
  }
  return retained;
}

export function applyContextBudget(
  messages: ChatMessage[], systemPrompt: string, tools: OpenAIToolSchema[], contextWindow: number,
  budget: BudgetSettings, charsPerToken = 4,
): BudgetResult {
  const systemTokens = estimateTokens(systemPrompt, charsPerToken);
  const toolsTokens = estimateTokens(JSON.stringify(tools), charsPerToken);
  const available = Math.max(0, Math.min(budget.historyMax, contextWindow - budget.outputReserve - systemTokens - toolsTokens));
  let historyTokens = estimateMessages(messages, charsPerToken);
  let prunedChars = 0;
  if (historyTokens > available) {
    for (const message of messages) {
      if (message.role !== 'tool' || historyTokens <= available) continue;
      const original = message.content;
      if (original.startsWith('[truncated ')) continue;
      message.content = `[truncated ${original.length} chars]`;
      prunedChars += Math.max(0, original.length - message.content.length);
      historyTokens = estimateMessages(messages, charsPerToken);
    }
  }
  return {
    estimatedTokens: systemTokens + toolsTokens + historyTokens,
    historyTokens,
    prunedChars,
    needsCompression: historyTokens > available,
  };
}
