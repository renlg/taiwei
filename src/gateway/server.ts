import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatBridge } from './chat.js';
import { AUTH_SESSION_TTL_MS, AuthSessionStore } from './auth.js';
import { SessionStore, type SessionToolCall } from './sessions.js';
import { openSse, sendSse } from './sse.js';
import { getCurrentModel, resolveModels, setCurrentModel, type ModelListResult } from '../config/model.js';

export interface GatewayModelState {
  getCurrentModel(): Promise<string>;
  resolveModels(): Promise<ModelListResult>;
  setCurrentModel(name: string): Promise<unknown>;
}

export interface GatewayServerOptions {
  chat: ChatBridge;
  publicDirectory?: string;
  sessions?: SessionStore;
  modelState?: GatewayModelState;
  log?: (message: string) => void;
  auth?: { enabled: boolean; username: string; password: string };
  authSessions?: AuthSessionStore;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC_ASSET_VERSION = '2';

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const LOGIN_WINDOW_MS = 10 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 5;

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function requestToken(request: IncomingMessage): string | undefined {
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

function sessionCookie(token: string, maxAge = Math.floor(AUTH_SESSION_TTL_MS / 1_000)): string {
  return `taiwei_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
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

export function createGatewayServer(options: GatewayServerOptions): Server {
  const publicDirectory = options.publicDirectory ?? DEFAULT_PUBLIC_DIRECTORY;
  const sessions = options.sessions ?? new SessionStore();
  const authSessions = options.authSessions ?? new AuthSessionStore();
  const authEnabled = options.auth?.enabled ?? false;
  if (authEnabled && !options.auth?.password) {
    throw new Error('Gateway auth is enabled but no password is set. Set auth.password in ~/.taiwei/config.json or TAIWEI_AUTH_PASSWORD.');
  }
  const log = options.log ?? console.log;
  const modelState: GatewayModelState = options.modelState ?? { getCurrentModel, resolveModels, setCurrentModel };
  const loginFailures = new Map<string, { count: number; windowStartedAt: number }>();
  return createServer(async (request, response) => {
    const started = Date.now();
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    response.once('finish', () => log(`[taiwei] ${method} ${pathname} ${response.statusCode} ${Date.now() - started}ms`));
    try {
      if (method === 'GET' && pathname === '/api/health') {
        json(response, 200, { ok: true });
        return;
      }
      if (method === 'POST' && pathname === '/api/login') {
        if (!authEnabled) {
          json(response, 404, { error: 'Authentication is disabled' });
          return;
        }
        const ip = request.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const failures = loginFailures.get(ip);
        if (failures && now - failures.windowStartedAt < LOGIN_WINDOW_MS && failures.count >= MAX_LOGIN_FAILURES) {
          log(`[taiwei] Warning: login rate limit reached for ${ip}`);
          json(response, 429, { error: 'Too many login attempts. Try again later.' });
          return;
        }
        const body = await readJson(request) as { username?: unknown; password?: unknown };
        const valid = typeof body?.username === 'string'
          && typeof body?.password === 'string'
          && constantTimeEqual(body.username, options.auth?.username ?? '')
          && constantTimeEqual(body.password, options.auth?.password ?? '');
        if (!valid) {
          const active = failures && now - failures.windowStartedAt < LOGIN_WINDOW_MS
            ? failures : { count: 0, windowStartedAt: now };
          active.count += 1;
          loginFailures.set(ip, active);
          json(response, 401, { error: 'Invalid username or password' });
          return;
        }
        loginFailures.delete(ip);
        const token = await authSessions.create(body.username as string);
        json(response, 200, { token }, { 'set-cookie': sessionCookie(token) });
        return;
      }
      let authenticatedToken: string | undefined;
      if (authEnabled && pathname.startsWith('/api/')) {
        authenticatedToken = requestToken(request);
        const authenticated = authenticatedToken ? await authSessions.authenticate(authenticatedToken) : undefined;
        if (!authenticated) {
          json(response, 401, { error: 'unauthorized' });
          return;
        }
      }
      if (method === 'POST' && pathname === '/api/logout') {
        if (authenticatedToken) await authSessions.delete(authenticatedToken);
        json(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
        return;
      }
      if (method === 'GET' && pathname === '/api/info') {
        json(response, 200, { model: await modelState.getCurrentModel(), authEnabled });
        return;
      }
      if (method === 'GET' && pathname === '/api/models') {
        const listed = await modelState.resolveModels();
        json(response, 200, { models: listed.models, current: listed.current });
        return;
      }
      if (method === 'GET' && pathname === '/api/model') {
        json(response, 200, { current: await modelState.getCurrentModel() });
        return;
      }
      if (method === 'POST' && pathname === '/api/model') {
        const body = await readJson(request) as { model?: unknown };
        if (typeof body?.model !== 'string' || !body.model.trim()) {
          json(response, 400, { error: 'model must be a non-empty string' });
          return;
        }
        const model = body.model.trim();
        const listed = await modelState.resolveModels();
        const known = listed.models.includes(model) || model === listed.current;
        if (!known && listed.source !== 'fallback') {
          json(response, 400, { error: `Unknown model: ${model}`, models: listed.models });
          return;
        }
        await modelState.setCurrentModel(model);
        json(response, 200, { ok: true, current: model });
        return;
      }
      if (method === 'GET' && pathname === '/api/sessions') {
        json(response, 200, await sessions.list());
        return;
      }
      if (method === 'POST' && pathname === '/api/sessions') {
        json(response, 201, await sessions.create());
        return;
      }
      const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionRoute && method === 'GET') {
        const session = await sessions.get(decodeURIComponent(sessionRoute[1]));
        if (!session) json(response, 404, { error: 'Session not found' });
        else json(response, 200, session);
        return;
      }
      if (sessionRoute && method === 'DELETE') {
        const deleted = await sessions.delete(decodeURIComponent(sessionRoute[1]));
        if (!deleted) json(response, 404, { error: 'Session not found' });
        else { response.writeHead(204); response.end(); }
        return;
      }
      if (method === 'POST' && pathname === '/api/stop') {
        json(response, 200, { stopped: options.chat.stop() });
        return;
      }
      if (method === 'POST' && pathname === '/api/chat') {
        const body = await readJson(request) as { message?: unknown; sessionId?: unknown };
        if (typeof body?.message !== 'string' || !body.message.trim()) {
          json(response, 400, { error: 'message must be a non-empty string' });
          return;
        }
        if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
          json(response, 400, { error: 'sessionId must be a string' });
          return;
        }
        const session = typeof body.sessionId === 'string' ? await sessions.get(body.sessionId) : await sessions.create();
        if (!session) {
          json(response, 404, { error: 'Session not found' });
          return;
        }
        const message = body.message.trim();
        const history = sessions.toChatHistory(session);
        if (!session.messages.some((item) => item.role === 'user')) session.title = sessions.titleFrom(message) || session.title;
        session.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
        openSse(response);
        let completed = false;
        let answer = '';
        let finalText: string | undefined;
        let turnError: Error | undefined;
        const toolCalls: SessionToolCall[] = [];
        response.once('close', () => { if (!completed) options.chat.stop(); });
        await options.chat.run(message, {
          event: (event) => {
            if (event.type === 'token') {
              answer += event.text;
              sendSse(response, 'token', { text: event.text });
            } else if (event.type === 'tool') {
              toolCalls.push({ name: event.name, args: event.args });
              sendSse(response, 'tool', { name: event.name, args: event.args });
            } else if (event.type === 'tool_result') {
              const call = [...toolCalls].reverse().find((item) => item.name === event.name && item.result === undefined);
              if (call) call.result = event.result;
              sendSse(response, 'tool_result', { name: event.name, result: event.result });
            } else {
              finalText = event.text;
              sendSse(response, 'done', { text: event.text, sessionId: session.id });
            }
          },
          error: (error) => { turnError = error; sendSse(response, 'error', { message: error.message }); },
        }, history);
        const content = finalText ?? answer;
        if (finalText !== undefined || content || toolCalls.length || turnError) {
          const stopped = turnError?.message === 'Turn cancelled';
          session.messages.push({
            role: 'assistant',
            content: content || (stopped ? '' : turnError?.message ?? ''),
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(turnError ? { status: stopped ? 'stopped' as const : 'error' as const } : {}),
            timestamp: new Date().toISOString(),
          });
        }
        session.updatedAt = new Date().toISOString();
        await sessions.save(session);
        completed = true;
        response.end();
        return;
      }
      const staticMatch = pathname.match(/^\/([^/]+)(\.[^.]+)$/);
      const staticContentType = staticMatch ? STATIC_CONTENT_TYPES[staticMatch[2].toLowerCase()] : undefined;
      if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || staticContentType)) {
        const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
        const fileContent = await readFile(join(publicDirectory, filename));
        const isHtml = filename.endsWith('.html');
        const content = isHtml
          ? Buffer.from(fileContent.toString('utf8').replaceAll('{{ASSET_VERSION}}', STATIC_ASSET_VERSION))
          : fileContent;
        response.writeHead(200, {
          'content-type': staticContentType ?? STATIC_CONTENT_TYPES['.html'],
          'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
          'content-length': content.byteLength,
        });
        response.end(method === 'HEAD' ? undefined : content);
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: (error as Error).message });
      else { sendSse(response, 'error', { message: (error as Error).message }); response.end(); }
    }
  });
}

export async function listenGateway(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind to a TCP port');
  return address.port;
}

export async function closeGateway(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
