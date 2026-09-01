import type { ModelListResult } from '../config/model.js';
import { ProviderHttpError } from '../llm/retry.js';
import { HttpError } from './http.js';

export function contentWithTurnError(content: string, message: string): string {
  const error = `[错误] ${message || '未知错误'}`;
  return content ? `${content}\n\n${error}` : error;
}

export function providerFailureStatus(error: unknown): number | undefined {
  if (error instanceof ProviderHttpError) return error.status;
  const match = (error instanceof Error ? error.message : String(error)).match(/(?:Provider request failed|Provider is temporarily unavailable) \((\d{3})\)/i);
  return match ? Number(match[1]) : undefined;
}

export function formatGatewayTurnError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const status = providerFailureStatus(error);
  if (!status) return raw;
  let detail = raw.replace(/^.*?\(\d{3}\):\s*/s, '').trim();
  if (detail.startsWith('{')) {
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: unknown }; message?: unknown };
      const extracted = parsed.error?.message ?? parsed.message;
      if (typeof extracted === 'string') detail = extracted;
    } catch { detail = '上游服务返回了无效响应'; }
  }
  const label = status >= 500 ? '模型服务暂时不可用' : '模型服务请求失败';
  return `${label}（${status}）：${detail || '未知错误'}。请稍后重试或切换模型。`;
}

export function openAiMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text);
  }
  return texts.join('');
}

export function joinedOpenAiMessages(value: unknown): { message: string; promptText: string } {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'messages must be a non-empty array');
  const messages = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, `messages[${index}] must be an object`);
    const candidate = item as { role?: unknown; content?: unknown };
    if (candidate.role !== 'system' && candidate.role !== 'user' && candidate.role !== 'assistant') {
      throw new HttpError(400, `messages[${index}].role must be system, user, or assistant`);
    }
    const content = openAiMessageText(candidate.content);
    if (content === undefined) throw new HttpError(400, `messages[${index}].content must be a string or text content array`);
    return { role: candidate.role, content };
  });
  const last = messages.at(-1)!;
  const prior = messages.slice(0, -1).map((item) => `[${item.role}]\n${item.content}`).join('\n\n');
  const message = prior ? `Conversation context:\n${prior}\n\nCurrent instruction:\n${last.content}` : last.content;
  if (!message.trim()) throw new HttpError(400, 'the final message content must be non-empty');
  return { message, promptText: messages.map((item) => item.content).join('\n') };
}

export function openAiModels(listed: ModelListResult): Array<{ id: string; object: 'model'; created: number; owned_by: string }> {
  const seen = new Set<string>();
  const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [];
  for (const provider of listed.providers ?? []) {
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      data.push({ id: model.id, object: 'model', created: 0, owned_by: provider.id });
    }
  }
  for (const model of listed.models) {
    if (seen.has(model)) continue;
    seen.add(model);
    data.push({ id: model, object: 'model', created: 0, owned_by: listed.currentProvider ?? 'taiwei' });
  }
  return data;
}
