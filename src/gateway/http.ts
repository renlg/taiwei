import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import type { TaiweiConfig } from '../config/config.js';
import { AUTH_SESSION_TTL_MS } from './auth.js';
import type { LoginLock } from './login-locks.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

export type OpenAiErrorType = 'invalid_request_error' | 'authentication_error' | 'forbidden' | 'server_error';

export function openAiError(response: ServerResponse, status: number, message: string, type: OpenAiErrorType): void {
  json(response, status, { error: { message, type, code: null } });
}

export function openAiSse(response: ServerResponse, data: unknown | '[DONE]'): void {
  response.write(`data: ${data === '[DONE]' ? data : JSON.stringify(data)}\n\n`);
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function requestToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim() || undefined;
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split('=');
    if (name === 'taiwei_token') {
      try { return decodeURIComponent(parts.join('=')); }
      catch { return undefined; }
    }
  }
  return undefined;
}

export function requestShareToken(request: IncomingMessage): string | undefined {
  const header = request.headers['x-share-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const urlToken = new URL(request.url ?? '/', 'http://localhost').searchParams.get('share');
  if (urlToken) return urlToken;
  for (const cookie of request.headers.cookie?.split(';') ?? []) {
    const [name, ...parts] = cookie.trim().split('=');
    if (name === 'taiwei_share_token') {
      try { return decodeURIComponent(parts.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}

export function requestApiKey(request: IncomingMessage): string | undefined {
  const header = request.headers['x-api-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() || undefined : undefined;
}

export function sessionCookie(token: string, maxAge = Math.floor(AUTH_SESSION_TTL_MS / 1_000)): string {
  return `taiwei_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function requestOrigin(request: IncomingMessage, config: TaiweiConfig): string {
  const host = request.headers.host ?? `${config.gateway.host}:${config.gateway.port}`;
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProtocol === 'string' && forwardedProtocol.split(',')[0]?.trim() === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

export function safeInlineJson(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Request body must be valid JSON'); }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function readUpload(request: IncomingMessage): Promise<Buffer> {
  const declaredSize = Number(request.headers['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) throw new HttpError(413, '文件不能超过 10 MB');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, '文件不能超过 10 MB');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function sanitizeFilename(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').pop() ?? '';
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^\p{L}\p{N}._()\- ]/gu, '_').replace(/^\.+/, '').trim();
  return clean.slice(0, 180) || 'attachment';
}

export function lockMessage(lock: LoginLock): string {
  return lock === 'pair_permanent' ? '该账号已锁定，请联系管理员' : '失败次数过多，请稍后再试';
}

export function withinDirectory(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}
