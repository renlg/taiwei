import type { TaiweiConfig } from '../config/config.js';
import type { Embedder } from './index.js';

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
  error?: { message?: string };
}

export class OpenAICompatibleEmbedder implements Embedder {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs?: number;
    },
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.options.model, input: texts }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as EmbeddingResponse;
      if (!response.ok) throw new Error(body.error?.message ?? `Embedding provider returned HTTP ${response.status}`);
      if (!Array.isArray(body.data) || body.data.length !== texts.length) {
        throw new Error(`Embedding provider returned ${body.data?.length ?? 0} vectors for ${texts.length} inputs`);
      }
      const ordered = body.data.map((item, position) => ({ ...item, index: item.index ?? position }))
        .sort((left, right) => left.index - right.index);
      return ordered.map((item) => {
        if (!Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
          throw new Error('Embedding provider returned an invalid vector');
        }
        return item.embedding as number[];
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error(`Embedding request timed out after ${this.options.timeoutMs ?? 30_000}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createEmbedder(config: TaiweiConfig): OpenAICompatibleEmbedder {
  return new OpenAICompatibleEmbedder({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.embedModel,
    timeoutMs: 30_000,
  });
}
