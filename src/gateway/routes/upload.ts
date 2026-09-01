import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { HttpError, json, readUpload, sanitizeFilename } from '../http.js';
import { uploadedText } from '../attachments.js';
import { uploadToOss } from '../oss.js';
import type { RouteContext } from './route-context.js';

/** Handles POST /api/upload (OSS-backed or local uploads directory). */
export async function handleUploadRoute(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { options, configState, uploadsDirectory } = runtime;
  const { guestId } = ctx.scope.auth;
  if (method !== 'POST' || pathname !== '/api/upload') return false;

  const url = new URL(request.url ?? '/', 'http://localhost');
  const headerName = request.headers['x-file-name'];
  const rawName = typeof headerName === 'string' ? headerName : url.searchParams.get('name') ?? '';
  let decodedName = rawName;
  try { decodedName = decodeURIComponent(rawName); } catch {}
  const name = sanitizeFilename(decodedName);
  if (!rawName) throw new HttpError(400, '缺少文件名');
  const data = await readUpload(request);
  const type = request.headers['content-type'] || 'application/octet-stream';
  const text = uploadedText(data, name, type);
  const config = await configState.load();
  if (config.oss.enabled) {
    const uploadOverride = guestId ? { prefix: `${config.oss.prefix}/guests/${guestId}` } : undefined;
    const uploaded = await (options.ossUpload ?? uploadToOss)(data, name, type, config.oss, uploadOverride);
    json(response, 201, { name, url: uploaded.url, path: uploaded.url, size: data.byteLength, type, ...text });
    return true;
  }
  const requestedGroup = request.headers['x-session-id'];
  const baseGroup = sanitizeFilename(typeof requestedGroup === 'string' ? requestedGroup : 'unassigned');
  const group = guestId ? `${guestId}-${baseGroup}` : baseGroup;
  const directory = join(uploadsDirectory, group);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${Date.now()}-${randomUUID()}-${name}`);
  await writeFile(path, data, { flag: 'wx' });
  json(response, 201, { name, path: resolve(path), size: data.byteLength, type, ...text });
  return true;
}
