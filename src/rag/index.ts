import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { ensureTaiweiHome } from '../util/paths.js';

export interface RagChunk {
  id: string;
  source: string;
  text: string;
  tokens: string[];
}

export interface RagIndexData {
  version: 1;
  createdAt: string;
  chunks: RagChunk[];
  /** Parallel to chunks. Absent on legacy or BM25-only indexes. */
  vectors?: number[][];
  embedModel?: string;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length > 1);
}

async function walk(directory: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(path));
    else if (['.md', '.txt'].includes(extname(entry.name).toLowerCase())) results.push(path);
  }
  return results;
}

export function chunkText(text: string, maxChars = 1000, overlap = 150): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current);
      current = `${current.slice(-overlap)}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars - overlap);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function buildIndex(embedder?: Embedder): Promise<RagIndexData> {
  const paths = await ensureTaiweiHome();
  const chunks: RagChunk[] = [];
  for (const path of await walk(paths.knowledge)) {
    const source = relative(paths.knowledge, path);
    chunkText(await readFile(path, 'utf8')).forEach((text, index) => {
      chunks.push({ id: `${source}:${index}`, source, text, tokens: tokenize(text) });
    });
  }
  let vectors: number[][] | undefined;
  let embedModel: string | undefined;
  try {
    if (!embedder) {
      const [{ loadConfig }, { createEmbedder }] = await Promise.all([
        import('../config/config.js'), import('./embedding.js'),
      ]);
      const config = await loadConfig();
      embedModel = config.embedModel;
      embedder = createEmbedder(config);
    }
    vectors = [];
    for (let offset = 0; offset < chunks.length; offset += 32) {
      vectors.push(...await embedder.embed(chunks.slice(offset, offset + 32).map((chunk) => chunk.text)));
    }
    if (vectors.length !== chunks.length) throw new Error('Embedding count does not match chunk count');
    const dimensions = vectors[0]?.length;
    if (vectors.some((vector) => !vector.length || vector.length !== dimensions)) throw new Error('Embedding dimensions are inconsistent');
  } catch {
    // A lexical index is still useful when the embedding provider is unavailable.
    vectors = undefined;
    embedModel = undefined;
  }
  const data: RagIndexData = {
    version: 1, createdAt: new Date().toISOString(), chunks,
    ...(vectors ? { vectors } : {}),
    ...(embedModel ? { embedModel } : {}),
  };
  await writeFile(paths.ragIndex, `${JSON.stringify(data)}\n`, 'utf8');
  return data;
}

export async function loadIndex(): Promise<RagIndexData> {
  const paths = await ensureTaiweiHome();
  try { return JSON.parse(await readFile(paths.ragIndex, 'utf8')) as RagIndexData; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return buildIndex();
    throw new Error(`Could not load RAG index: ${(error as Error).message}`);
  }
}
