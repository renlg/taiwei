import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatBridge } from './chat.js';
import { openSse, sendSse } from './sse.js';

export interface GatewayServerOptions {
  chat: ChatBridge;
  publicDirectory?: string;
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
      if (method === 'POST' && pathname === '/api/stop') {
        json(response, 200, { stopped: options.chat.stop() });
        return;
      }
      if (method === 'POST' && pathname === '/api/chat') {
        const body = await readJson(request) as { message?: unknown };
        if (typeof body?.message !== 'string' || !body.message.trim()) {
          json(response, 400, { error: 'message must be a non-empty string' });
          return;
        }
        openSse(response);
        let completed = false;
        response.once('close', () => { if (!completed) options.chat.stop(); });
        await options.chat.run(body.message.trim(), {
          event: (event) => sendSse(response, event.type, event.type === 'tool_result'
            ? { name: event.name, result: event.result }
            : event.type === 'tool' ? { name: event.name, args: event.args }
              : { text: event.text }),
          error: (error) => sendSse(response, 'error', { message: error.message }),
        });
        completed = true;
        response.end();
        return;
      }
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js')) {
        const filename = pathname === '/app.js' ? 'app.js' : 'index.html';
        const content = await readFile(join(publicDirectory, filename));
        response.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
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
