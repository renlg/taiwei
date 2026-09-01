import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { RagIndexData } from '../rag/index.js';
import { HttpError } from './http.js';

export const KNOWLEDGE_EXTENSIONS = new Set(['.md', '.txt']);

export async function walkKnowledge(directory: string, root = directory): Promise<Array<{ path: string; size: number; mtime: string }>> {
  const files: Array<{ path: string; size: number; mtime: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkKnowledge(path, root));
    else if (entry.isFile() && KNOWLEDGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const info = await stat(path);
      files.push({ path: relative(root, path).replaceAll('\\', '/'), size: info.size, mtime: info.mtime.toISOString() });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function knowledgeIndexStatus(path: string): Promise<{ exists: boolean; chunks: number; hasVectors: boolean; embedModel: string | null; updatedAt: string | null }> {
  try {
    const index = JSON.parse(await readFile(path, 'utf8')) as RagIndexData;
    return {
      exists: true,
      chunks: Array.isArray(index.chunks) ? index.chunks.length : 0,
      hasVectors: Array.isArray(index.vectors) && index.vectors.length > 0,
      embedModel: index.embedModel ?? null,
      updatedAt: index.createdAt ?? null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, chunks: 0, hasVectors: false, embedModel: null, updatedAt: null };
    throw new HttpError(500, `无法读取知识库索引：${(error as Error).message}`);
  }
}
