import type { RagChunk, RagIndexData } from './index.js';
import { tokenize } from './index.js';

export interface SearchResult extends RagChunk { score: number; }

export function searchIndex(index: RagIndexData, query: string, limit = 5): SearchResult[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.chunks.length) return [];
  const documentCount = index.chunks.length;
  const averageLength = index.chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / documentCount || 1;
  const frequencies = new Map(terms.map((term) => [term, index.chunks.filter((chunk) => chunk.tokens.includes(term)).length]));
  const k1 = 1.5;
  const b = 0.75;
  return index.chunks.map((chunk) => {
    const counts = new Map<string, number>();
    for (const token of chunk.tokens) if (terms.includes(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const df = frequencies.get(term) ?? 0;
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * chunk.tokens.length / averageLength)));
    }
    return { ...chunk, score };
  }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

export async function retrieve(query: string, limit = 5): Promise<SearchResult[]> {
  const { loadIndex } = await import('./index.js');
  return searchIndex(await loadIndex(), query, limit);
}
