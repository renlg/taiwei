import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatBridge } from './chat.js';
import { SessionStore, type SessionToolCall } from './sessions.js';
import { openSse, sendSse } from './sse.js';

export interface GatewayServerOptions {
  chat: ChatBridge;
  publicDirectory?: string;
  sessions?: SessionStore;
  model?: string;
  log?: (message: string) => void;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
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
  const log = options.log ?? console.log;
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
      if (method === 'GET' && pathname === '/api/info') {
        json(response, 200, { model: options.model ?? 'OpenAI compatible' });
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
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/style.css')) {
        const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
        const content = await readFile(join(publicDirectory, filename));
        const contentType = filename.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
        response.writeHead(200, { 'content-type': contentType });
        response.end(content);
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
