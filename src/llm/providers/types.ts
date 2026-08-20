import type { OpenAIToolSchema } from '../tools.js';
import type { ChatMessage, ChatResult } from '../client.js';
import type { ModelDef } from '../catalog.js';
import type { RetryOptions } from '../retry.js';

export type ProviderType = 'openai-compatible' | 'anthropic' | 'responses';

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  type: ProviderType;
  defaultModel?: string;
  models?: ModelDef[];
  /** 模型能力类型：text（默认，文本）/ image（图片生成）/ video（视频生成）。模型选择器只展示 text。 */
  modality?: 'text' | 'image' | 'video';
}

export interface ProviderRequest {
  provider: ProviderConfig;
  model: string;
  messages: ChatMessage[];
  tools: OpenAIToolSchema[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onText?: (text: string) => void;
  fallbackModel?: string;
  retry?: Omit<RetryOptions, 'onRetry'>;
  onAttempt?: (event: { model: string; attempt: number; delayMs?: number; outcome: 'start' | 'retry' | 'success' | 'fallback' }) => void;
}

export interface ProviderAdapter {
  readonly type: ProviderType;
  stream(request: ProviderRequest): Promise<ChatResult>;
}
