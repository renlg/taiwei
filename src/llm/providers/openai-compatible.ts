import type { ChatRequest, ChatResult } from '../client.js';
import { openAICompatibleStream } from '../client.js';
import type { ProviderAdapter, ProviderRequest } from './types.js';

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const;
  stream(request: ProviderRequest): Promise<ChatResult> {
    const legacy: ChatRequest = {
      baseUrl: request.provider.baseUrl,
      apiKey: request.provider.apiKey ?? '',
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      onText: request.onText,
      fallbackModel: request.fallbackModel,
      retry: request.retry,
      onAttempt: request.onAttempt,
    };
    return openAICompatibleStream(legacy);
  }
}
