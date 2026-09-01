import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { HttpError, json, readUpload, sanitizeFilename, withinDirectory } from '../http.js';
import { KNOWLEDGE_EXTENSIONS, knowledgeIndexStatus, walkKnowledge } from '../knowledge-helpers.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/knowledge* routes. */
export async function handleKnowledgeRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { knowledgeDirectory, ragIndexPath, buildKnowledgeIndex, searchKnowledge } = runtime;
  if (!pathname.startsWith('/api/knowledge')) return false;

  if (method === 'GET' && pathname === '/api/knowledge') {
    await mkdir(knowledgeDirectory, { recursive: true });
    json(response, 200, { files: await walkKnowledge(knowledgeDirectory), index: await knowledgeIndexStatus(ragIndexPath) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/knowledge/rebuild') {
    await mkdir(knowledgeDirectory, { recursive: true });
    let index;
    try { index = await buildKnowledgeIndex(); }
    catch (error) { throw new HttpError(500, `重建知识库索引失败：${(error as Error).message}`); }
    if (!index.chunks.length) throw new HttpError(400, '知识库文件中没有可索引的内容');
    json(response, 200, {
      ok: true,
      chunks: index.chunks.length,
      hasVectors: Boolean(index.vectors?.length),
      embedModel: index.embedModel ?? null,
    });
    return true;
  }
  if (method === 'GET' && pathname === '/api/knowledge/search') {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) throw new HttpError(400, 'q 不能为空');
    const requestedLimit = Number(url.searchParams.get('limit') ?? 5);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20) throw new HttpError(400, 'limit 必须是 1 到 20 的整数');
    const results = await searchKnowledge(query, requestedLimit);
    json(response, 200, { results: results.map(({ text, score }) => ({ text, score })) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/knowledge/upload') {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const headerName = request.headers['x-file-name'];
    const rawName = typeof headerName === 'string' ? headerName : url.searchParams.get('name') ?? '';
    if (!rawName) throw new HttpError(400, '缺少文件名');
    let decodedName = rawName;
    try { decodedName = decodeURIComponent(rawName); } catch {}
    const name = sanitizeFilename(decodedName);
    if (!KNOWLEDGE_EXTENSIONS.has(extname(name).toLowerCase())) throw new HttpError(400, '知识库只支持 .md 和 .txt 文件');
    const data = await readUpload(request);
    await mkdir(knowledgeDirectory, { recursive: true });
    await writeFile(join(knowledgeDirectory, name), data);
    json(response, 201, { path: name });
    return true;
  }
  if (method === 'DELETE' && pathname === '/api/knowledge') {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const requestedPath = url.searchParams.get('path') ?? '';
    if (!requestedPath) throw new HttpError(400, 'path 不能为空');
    if (isAbsolute(requestedPath) || !KNOWLEDGE_EXTENSIONS.has(extname(requestedPath).toLowerCase())) throw new HttpError(400, '知识库路径无效');
    const target = resolve(knowledgeDirectory, requestedPath);
    if (!withinDirectory(target, knowledgeDirectory)) throw new HttpError(400, '知识库路径无效');
    const info = await stat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info?.isFile()) throw new HttpError(404, '知识库文件不存在');
    await unlink(target);
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}
