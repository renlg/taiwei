import type { Embedder, RagChunk, RagIndexData } from './index.js';
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

function cosineSimilarity(left: number[], right: number[]): number | undefined {
  if (!left.length || left.length !== right.length) return undefined;
  let dot = 0, leftMagnitude = 0, rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return undefined;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function searchIndexHybrid(index: RagIndexData, query: string, queryVector: number[], limit = 5, candidateLimit = 20): SearchResult[] {
  if (!index.chunks.length || index.vectors?.length !== index.chunks.length) return searchIndex(index, query, limit);
  const poolSize = Math.max(limit, candidateLimit);
  const lexical = searchIndex(index, query, poolSize);
  const semantic = index.chunks.map((chunk, position) => ({
    chunk,
    similarity: cosineSimilarity(queryVector, index.vectors![position]),
  })).filter((item): item is { chunk: RagChunk; similarity: number } => item.similarity !== undefined)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, poolSize);

  // Reciprocal Rank Fusion combines unlike BM25/cosine score scales without calibration.
  const scores = new Map<string, number>();
  for (const ranking of [lexical, semantic.map((item) => item.chunk)]) {
    ranking.forEach((chunk, rank) => scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (60 + rank + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ ...index.chunks.find((chunk) => chunk.id === id)!, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, limit));
}

export async function retrieve(query: string, limit = 5, embedder?: Embedder): Promise<SearchResult[]> {
  const { loadIndex } = await import('./index.js');
  const index = await loadIndex();
  const lexical = () => searchIndex(index, query, limit);
  if (!index.vectors || index.vectors.length !== index.chunks.length) return lexical();
  try {
    if (!embedder) {
      const [{ loadConfig }, { createEmbedder }] = await Promise.all([
        import('../config/config.js'), import('./embedding.js'),
      ]);
      embedder = createEmbedder(await loadConfig());
    }
    const [queryVector] = await embedder.embed([query]);
    if (!queryVector) return lexical();
    return searchIndexHybrid(index, query, queryVector, limit);
  } catch {
    return lexical();
  }
}
