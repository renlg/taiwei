import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatBridge } from './chat.js';
import { AUTH_SESSION_TTL_MS, AuthSessionStore } from './auth.js';
import { LoginLockStore, type LoginLock } from './login-locks.js';
import { SessionStore, type SessionToolCall } from './sessions.js';
import { openSse, sendSse } from './sse.js';
import { getCurrentModel, resolveModels, setCurrentModel, type ModelListResult } from '../config/model.js';
import { DEFAULT_CONFIG, expandHome, loadConfig, resolveContextWindow, resolveWorkspaceDir, saveConfig, type TaiweiConfig } from '../config/config.js';
import { getPaths } from '../util/paths.js';
import { DEFAULT_DANGER_PATTERNS } from '../security/commands.js';
import { ConfirmationBroker } from './confirmations.js';
import { HOOK_EVENTS, HookRunner, type HookCommands, type HookEvent } from '../hooks/runner.js';

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
  contextWindow?: (model: string) => number | Promise<number>;
  log?: (message: string) => void;
  auth?: { enabled: boolean; username: string; password: string };
  authSessions?: AuthSessionStore;
  loginLocks?: LoginLockStore;
  uploadsDirectory?: string;
  confirmations?: ConfirmationBroker;
  configState?: { load(): Promise<TaiweiConfig>; save(config: TaiweiConfig): Promise<void> };
  hooks?: HookRunner;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC_ASSET_VERSION = '6';

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

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 5;
const ATTACHMENT_TEXT_LIMIT = 8_000;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.go', '.c', '.h', '.cc',
  '.cpp', '.cxx', '.hpp', '.html', '.htm', '.css', '.scss', '.less', '.sql', '.sh', '.bash',
  '.zsh', '.fish', '.xml', '.toml', '.ini', '.conf', '.env', '.rs', '.rb', '.php', '.swift',
  '.kt', '.kts', '.scala', '.vue', '.svelte', '.tex', '.rst', '.properties', '.gradle', '.dockerfile',
]);

interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

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

async function readUpload(request: IncomingMessage): Promise<Buffer> {
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

function sanitizeFilename(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').pop() ?? '';
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^\p{L}\p{N}._()\- ]/gu, '_').replace(/^\.+/, '').trim();
  return clean.slice(0, 180) || 'attachment';
}

function lockMessage(lock: LoginLock): string {
  return lock === 'pair_permanent' ? '该账号已锁定，请联系管理员' : '失败次数过多，请稍后再试';
}

function withinDirectory(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

async function attachmentContext(files: unknown, uploadsDirectory: string): Promise<string> {
  if (files === undefined) return '';
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_MESSAGE) throw new HttpError(400, `files must contain at most ${MAX_FILES_PER_MESSAGE} uploads`);
  const sections: string[] = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Invalid uploaded file metadata');
    const candidate = item as Partial<UploadedFile>;
    if (typeof candidate.path !== 'string' || !withinDirectory(candidate.path, uploadsDirectory)) throw new HttpError(400, 'Invalid uploaded file path');
    const info = await stat(candidate.path).catch(() => undefined);
    if (!info?.isFile()) throw new HttpError(400, 'Uploaded file does not exist');
    const name = sanitizeFilename(typeof candidate.name === 'string' ? candidate.name : candidate.path.split('/').pop() ?? 'attachment');
    const extension = extname(name).toLowerCase();
    if (TEXT_EXTENSIONS.has(extension) || name.toLowerCase() === 'dockerfile') {
      const content = (await readFile(candidate.path, 'utf8')).slice(0, ATTACHMENT_TEXT_LIMIT).replaceAll('```', '``\u200b`');
      const truncated = info.size > Buffer.byteLength(content) ? '\n[内容已截断]' : '';
      sections.push(`[附件: ${name}]\n\`\`\`${extension.slice(1) || 'text'}\n${content}${truncated}\n\`\`\``);
    } else {
      sections.push(`[附件: ${name}] 路径: ${resolve(candidate.path)} (可通过工具读取)`);
    }
  }
  return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const publicDirectory = options.publicDirectory ?? DEFAULT_PUBLIC_DIRECTORY;
  const sessions = options.sessions ?? new SessionStore();
  const authSessions = options.authSessions ?? new AuthSessionStore();
  const loginLocks = options.loginLocks ?? new LoginLockStore();
  const confirmations = options.confirmations ?? new ConfirmationBroker();
  const configState = options.configState ?? { load: loadConfig, save: saveConfig };
  const uploadsDirectory = resolve(options.uploadsDirectory ?? getPaths().uploads);
  const authEnabled = options.auth?.enabled ?? false;
  if (authEnabled && !options.auth?.password) {
    throw new Error('Gateway auth is enabled but no password is set. Set auth.password in ~/.taiwei/config.json or TAIWEI_AUTH_PASSWORD.');
  }
  const log = options.log ?? console.log;
  const modelState: GatewayModelState = options.modelState ?? { getCurrentModel, resolveModels, setCurrentModel };
  const contextWindowFor = options.contextWindow ?? (async (model: string) => resolveContextWindow(await loadConfig(), model));
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
        const body = await readJson(request) as { username?: unknown; password?: unknown };
        const ip = request.socket.remoteAddress ?? 'unknown';
        const username = typeof body?.username === 'string' ? body.username : '';
        const valid = typeof body?.username === 'string'
          && typeof body?.password === 'string'
          && constantTimeEqual(body.username, options.auth?.username ?? '')
          && constantTimeEqual(body.password, options.auth?.password ?? '');
        const attempt = await loginLocks.attempt(username, ip, valid);
        if (attempt.lock) {
          log(`[taiwei] Warning: login lock ${attempt.lock} reached for ${ip} (${username || '<empty>'})`);
          json(response, 429, { error: lockMessage(attempt.lock) });
          return;
        }
        if (attempt.failed) {
          json(response, 401, { error: 'Invalid username or password' });
          return;
        }
        const token = await authSessions.create(body.username as string);
        json(response, 200, { token }, { 'set-cookie': sessionCookie(token) });
        return;
      }
      let authenticatedToken: string | undefined;
      let authenticatedUsername: string | undefined;
      if (authEnabled && pathname.startsWith('/api/')) {
        authenticatedToken = requestToken(request);
        const authenticated = authenticatedToken ? await authSessions.authenticate(authenticatedToken) : undefined;
        if (!authenticated) {
          json(response, 401, { error: 'unauthorized' });
          return;
        }
        authenticatedUsername = authenticated.username;
      }
      if (method === 'POST' && pathname === '/api/logout') {
        if (authenticatedToken) await authSessions.delete(authenticatedToken);
        json(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
        return;
      }
      if (method === 'GET' && pathname === '/api/info') {
        const model = await modelState.getCurrentModel();
        const config = await configState.load();
        json(response, 200, {
          model,
          contextWindow: await contextWindowFor(model),
          authEnabled,
          workspace: resolveWorkspaceDir(config),
          ...(authenticatedUsername ? { username: authenticatedUsername } : {}),
        });
        return;
      }
      if (method === 'GET' && pathname === '/api/settings') {
        const config = await configState.load();
        json(response, 200, {
          workspace: { dir: config.workspace.dir, resolvedDir: resolveWorkspaceDir(config) },
          security: {
            enabled: config.security.enabled,
            patterns: config.security.patterns,
            timeoutSeconds: config.security.timeoutSeconds,
            remember: config.security.remember,
            approvedPatterns: config.security.approvedPatterns,
            defaultPatterns: DEFAULT_DANGER_PATTERNS,
          },
          hooks: config.hooks,
          hookTimeoutSeconds: config.hookTimeoutSeconds,
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/settings') {
        const body = await readJson(request) as {
          workspace?: { dir?: unknown };
          security?: { enabled?: unknown; patterns?: unknown; timeoutSeconds?: unknown; remember?: unknown };
          hooks?: unknown;
          hookTimeoutSeconds?: unknown;
          resetSecurity?: unknown;
        };
        const config = await configState.load();
        if (body.workspace !== undefined) {
          if (!body.workspace || typeof body.workspace.dir !== 'string' || !body.workspace.dir.trim()) throw new HttpError(400, 'workspace.dir must be a non-empty string');
          const resolvedDir = expandHome(body.workspace.dir.trim());
          await mkdir(resolvedDir, { recursive: true });
          const info = await stat(resolvedDir);
          if (!info.isDirectory()) throw new HttpError(400, 'workspace.dir must resolve to a directory');
          config.workspace.dir = body.workspace.dir.trim();
        }
        if (body.resetSecurity === true) config.security = { ...DEFAULT_CONFIG.security, patterns: [], approvedPatterns: [] };
        if (body.security !== undefined) {
          const value = body.security;
          if (!value || typeof value !== 'object') throw new HttpError(400, 'security must be an object');
          if (value.enabled !== undefined) {
            if (typeof value.enabled !== 'boolean') throw new HttpError(400, 'security.enabled must be boolean');
            config.security.enabled = value.enabled;
          }
          if (value.timeoutSeconds !== undefined) {
            const timeout = Number(value.timeoutSeconds);
            if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new HttpError(400, 'security.timeoutSeconds must be an integer from 1 to 3600');
            config.security.timeoutSeconds = timeout;
          }
          if (value.remember !== undefined) {
            if (!['off', 'session', 'permanent'].includes(String(value.remember))) throw new HttpError(400, 'security.remember must be off, session, or permanent');
            config.security.remember = value.remember as TaiweiConfig['security']['remember'];
          }
          if (value.patterns !== undefined) {
            if (!Array.isArray(value.patterns) || !value.patterns.every((pattern) => typeof pattern === 'string' && pattern.trim())) throw new HttpError(400, 'security.patterns must be an array of non-empty regex strings');
            const patterns = value.patterns.map((pattern) => pattern.trim());
            for (const pattern of patterns) {
              try { new RegExp(pattern, 'i'); }
              catch (error) { throw new HttpError(400, `Invalid security regex ${pattern}: ${(error as Error).message}`); }
            }
            config.security.patterns = patterns;
          }
        }
        if (body.hookTimeoutSeconds !== undefined) {
          const timeout = Number(body.hookTimeoutSeconds);
          if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new HttpError(400, 'hookTimeoutSeconds must be an integer from 1 to 3600');
          config.hookTimeoutSeconds = timeout;
        }
        if (body.hooks !== undefined) config.hooks = validateHooks(body.hooks);
        await configState.save(config);
        options.hooks?.configure(config.hooks, config.hookTimeoutSeconds, resolveWorkspaceDir(config));
        json(response, 200, {
          ok: true,
          workspace: { dir: config.workspace.dir, resolvedDir: resolveWorkspaceDir(config) },
          security: config.security,
          hooks: config.hooks,
          hookTimeoutSeconds: config.hookTimeoutSeconds,
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/hooks/test') {
        const body = await readJson(request) as { event?: unknown; command?: unknown };
        if (!HOOK_EVENTS.includes(body.event as HookEvent)) throw new HttpError(400, 'event must be a supported hook event');
        if (typeof body.command !== 'string' || !body.command.trim()) throw new HttpError(400, 'command must be a non-empty string');
        const config = await configState.load();
        const workspace = resolveWorkspaceDir(config);
        await mkdir(workspace, { recursive: true });
        const runner = options.hooks ?? new HookRunner(config.hooks, config.hookTimeoutSeconds, workspace, log);
        runner.configure(config.hooks, config.hookTimeoutSeconds, workspace);
        const execution = await runner.test(body.command.trim(), body.event as HookEvent, sampleHookFields(body.event as HookEvent, workspace));
        json(response, 200, execution);
        return;
      }
      if (method === 'POST' && pathname === '/api/confirm') {
        const body = await readJson(request) as { id?: unknown; approve?: unknown; remember?: unknown };
        if (typeof body.id !== 'string' || typeof body.approve !== 'boolean') throw new HttpError(400, 'id and approve are required');
        if (body.remember !== undefined && !['off', 'session', 'permanent'].includes(String(body.remember))) throw new HttpError(400, 'remember must be off, session, or permanent');
        if (!confirmations.decide(body.id, { approve: body.approve, ...(body.remember ? { remember: body.remember as TaiweiConfig['security']['remember'] } : {}) })) {
          throw new HttpError(404, 'Confirmation is no longer pending');
        }
        json(response, 200, { ok: true });
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
        const known = listed.models.includes(model);
        if (!known && listed.source !== 'fallback') {
          json(response, 400, { error: `Unknown model: ${model}`, models: listed.models });
          return;
        }
        await modelState.setCurrentModel(model);
        json(response, 200, { ok: true, current: model, contextWindow: await contextWindowFor(model) });
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
      if (method === 'POST' && pathname === '/api/upload') {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const headerName = request.headers['x-file-name'];
        const rawName = typeof headerName === 'string' ? headerName : url.searchParams.get('name') ?? '';
        let decodedName = rawName;
        try { decodedName = decodeURIComponent(rawName); } catch {}
        const name = sanitizeFilename(decodedName);
        if (!rawName) throw new HttpError(400, '缺少文件名');
        const data = await readUpload(request);
        const requestedGroup = request.headers['x-session-id'];
        const group = sanitizeFilename(typeof requestedGroup === 'string' ? requestedGroup : 'unassigned');
        const directory = join(uploadsDirectory, group);
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${Date.now()}-${randomUUID()}-${name}`);
        await writeFile(path, data, { flag: 'wx' });
        json(response, 201, { name, path: resolve(path), size: data.byteLength, type: request.headers['content-type'] || 'application/octet-stream' });
        return;
      }
      if (method === 'POST' && pathname === '/api/chat') {
        const body = await readJson(request) as { message?: unknown; sessionId?: unknown; files?: unknown };
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
        const config = await configState.load();
        const workspace = resolveWorkspaceDir(config);
        await mkdir(workspace, { recursive: true });
        if (options.hooks) {
          options.hooks.configure(config.hooks, config.hookTimeoutSeconds, workspace);
          const gate = await options.hooks.run('beforeMessage', { sessionId: session.id, message });
          if (gate.block) {
            json(response, 403, { error: gate.reason ?? 'Message blocked by hook', blockedByHook: true });
            return;
          }
        }
        const agentMessage = `${message}${await attachmentContext(body.files, uploadsDirectory)}`;
        const history = sessions.toChatHistory(session);
        const activeModel = await modelState.getCurrentModel();
        const activeContextWindow = await contextWindowFor(activeModel);
        if (!session.messages.some((item) => item.role === 'user')) session.title = sessions.titleFrom(message) || session.title;
        session.messages.push({ role: 'user', content: message, ...(agentMessage !== message ? { agentContent: agentMessage } : {}), timestamp: new Date().toISOString() });
        openSse(response);
        let completed = false;
        let answer = '';
        let finalText: string | undefined;
        let turnError: Error | undefined;
        const toolCalls: SessionToolCall[] = [];
        response.once('close', () => { if (!completed) options.chat.stop(); });
        await options.chat.run(agentMessage, {
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
            } else if (event.type === 'usage') {
              const previous = session.usage;
              session.usage = {
                promptTokens: (previous?.promptTokens ?? 0) + event.usage.promptTokens,
                completionTokens: (previous?.completionTokens ?? 0) + event.usage.completionTokens,
                totalTokens: (previous?.totalTokens ?? 0) + event.usage.totalTokens,
                contextWindow: activeContextWindow,
                model: event.model || activeModel,
              };
              sendSse(response, 'usage', session.usage);
            } else {
              finalText = event.text;
              sendSse(response, 'done', { text: event.text, sessionId: session.id });
            }
          },
          error: (error) => { turnError = error; sendSse(response, 'error', { message: error.message }); },
          confirm: (request) => {
            sendSse(response, 'confirm', request);
            return confirmations.wait(request);
          },
        }, history, session.id);
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
      if (!response.headersSent) json(response, error instanceof HttpError ? error.status : 400, { error: (error as Error).message });
      else { sendSse(response, 'error', { message: (error as Error).message }); response.end(); }
    }
  });
}

function validateHooks(value: unknown): HookCommands {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'hooks must be an object');
  const record = value as Record<string, unknown>;
  return Object.fromEntries(HOOK_EVENTS.map((event) => {
    const commands = record[event];
    if (!Array.isArray(commands) || !commands.every((command) => typeof command === 'string')) {
      throw new HttpError(400, `hooks.${event} must be an array of command strings`);
    }
    return [event, commands.map((command) => command.trim()).filter(Boolean)];
  })) as unknown as HookCommands;
}

function sampleHookFields(event: HookEvent, workspace: string): Record<string, unknown> {
  if (event === 'beforeMessage') return { sessionId: 'test-session', message: 'Hook test message' };
  if (event === 'beforeLLM') return { sessionId: 'test-session', model: 'test-model', messagesCount: 1, lastMessagePreview: 'Hook test message' };
  if (event === 'afterLLM') return { sessionId: 'test-session', model: 'test-model', contentPreview: 'Hook test response', usage: { promptTokens: 10, completionTokens: 5 } };
  if (event === 'beforeTool') return { sessionId: 'test-session', tool: 'bash', args: { command: 'echo hook-test' }, cwd: workspace };
  return { sessionId: 'test-session', tool: 'bash', args: { command: 'echo hook-test' }, ok: true, resultPreview: 'hook-test' };
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
