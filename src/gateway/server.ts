import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatBridge } from './chat.js';
import { AUTH_SESSION_TTL_MS, AuthSessionStore } from './auth.js';
import { LoginLockStore, type LoginLock } from './login-locks.js';
import { SessionStore, type SessionToolCall } from './sessions.js';
import { openSse, sendSse } from './sse.js';
import { getCurrentModel, resolveModels, setCurrentModel, type ModelListResult } from '../config/model.js';
import { DEFAULT_CONFIG, expandHome, loadConfig, resolveContextWindow, resolveWorkspaceDir, saveConfig, type TaiweiConfig } from '../config/config.js';
import { hashPassword, isScryptPassword, verifyPassword } from '../config/password.js';
import { getPaths } from '../util/paths.js';
import { DEFAULT_DANGER_PATTERNS } from '../security/commands.js';
import { ConfirmationBroker } from './confirmations.js';
import { HOOK_EVENTS, HookRunner, type HookCommands, type HookEvent } from '../hooks/runner.js';
import { SkillLoader } from '../skills/loader.js';
import { buildIndex, type RagIndexData } from '../rag/index.js';
import { retrieve, type SearchResult } from '../rag/retrieve.js';
import { createEmbedder } from '../rag/embedding.js';
import { loadMcpConfig, type McpServerConfig } from '../mcp/client.js';
import { ToolRegistry, type ToolConfigSchema } from '../tools/registry.js';
import type { Skill } from '../skills/loader.js';
import { appendMessage as appendHistoryMessage, upsertSession as upsertHistorySession, type HistoryMessageInput, type HistorySessionMeta } from '../history/db.js';
import { MemoryStore } from '../memory/store.js';

export interface GatewayHistoryIndex {
  upsertSession(meta: HistorySessionMeta): Promise<void>;
  appendMessage(message: HistoryMessageInput): Promise<unknown>;
}

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
  authPasswordFromEnvironment?: boolean;
  authSessions?: AuthSessionStore;
  loginLocks?: LoginLockStore;
  uploadsDirectory?: string;
  confirmations?: ConfirmationBroker;
  configState?: { load(): Promise<TaiweiConfig>; save(config: TaiweiConfig): Promise<void> };
  hooks?: HookRunner;
  skillLoader?: Pick<SkillLoader, 'list' | 'load'> & Partial<Pick<SkillLoader, 'setDisabled' | 'isDisabled'>>;
  toolRegistry?: ToolRegistry;
  knowledgeDirectory?: string;
  ragIndexPath?: string;
  memoryDirectory?: string;
  memoryStore?: Pick<MemoryStore, 'read' | 'replace' | 'clear'>;
  buildKnowledgeIndex?: () => Promise<RagIndexData>;
  searchKnowledge?: (query: string, limit: number) => Promise<SearchResult[]>;
  mcpBridge?: {
    reload(): Promise<void>;
    list(): Array<{ name: string; connected: boolean; detail: string }>;
    test(config: McpServerConfig): Promise<{ connected: boolean; detail: string }>;
  };
  mcpConfigPath?: string;
  /** Defaults to the real history index for the normal SessionStore; custom stores may inject their own index. */
  history?: GatewayHistoryIndex | false;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC_ASSET_VERSION = '15';
const MAX_CUSTOM_PROMPT_LENGTH = 20_000;
const MAX_MEMORY_LENGTH = 50_000;

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
const KNOWLEDGE_EXTENSIONS = new Set(['.md', '.txt']);

function memoryStats(content: string): { chars: number; lines: number } {
  return { chars: content.length, lines: content ? content.split(/\r\n|\r|\n/).length : 0 };
}

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

function requestShareToken(request: IncomingMessage): string | undefined {
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

function guestIdForUsername(username: string): string {
  const safe = username.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `guest-${safe || 'user'}`;
}

function guestRouteAllowed(method: string, pathname: string): boolean {
  if (method === 'POST' && pathname === '/api/chat') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/sessions') return true;
  return (method === 'GET' || method === 'DELETE') && /^\/api\/sessions\/[^/]+$/.test(pathname);
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

async function walkKnowledge(directory: string, root = directory): Promise<Array<{ path: string; size: number; mtime: string }>> {
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

async function knowledgeIndexStatus(path: string): Promise<{ exists: boolean; chunks: number; hasVectors: boolean; embedModel: string | null; updatedAt: string | null }> {
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

type McpPublicServer = Omit<McpServerConfig, 'env'> & { envKeys: string[] };

function publicMcpServer(config: McpServerConfig): McpPublicServer {
  const { env, ...safe } = config;
  return { ...safe, envKeys: Object.keys(env ?? {}) };
}

function validateMcpServer(value: unknown): McpServerConfig & { preserveEnv?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'MCP server config must be an object');
  const body = value as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new HttpError(400, 'name must match [A-Za-z0-9_-]{1,32}');
  if (body.transport !== 'stdio' && body.transport !== 'sse') throw new HttpError(400, 'transport must be stdio or sse');
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (body.transport === 'stdio' && !command) throw new HttpError(400, 'stdio transport requires command');
  if (body.transport === 'sse') {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new HttpError(400, 'sse transport requires a valid url'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'sse url must use http or https');
  }
  if (body.args !== undefined && (!Array.isArray(body.args) || !body.args.every((arg) => typeof arg === 'string'))) {
    throw new HttpError(400, 'args must be an array of strings');
  }
  if (body.env !== undefined && (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)
    || !Object.entries(body.env as Record<string, unknown>).every(([key, item]) => key.trim() && typeof item === 'string'))) {
    throw new HttpError(400, 'env must be an object with non-empty keys and string values');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
  if (body.preserveEnv !== undefined && typeof body.preserveEnv !== 'boolean') throw new HttpError(400, 'preserveEnv must be boolean');
  return {
    name,
    transport: body.transport,
    ...(body.transport === 'stdio' ? { command } : { url }),
    ...(body.args !== undefined ? { args: [...body.args as string[]] } : {}),
    ...(body.env !== undefined ? { env: { ...body.env as Record<string, string> } } : {}),
    enabled: body.enabled !== false,
    ...(body.preserveEnv === true ? { preserveEnv: true } : {}),
  };
}

function validateToolConfig(value: unknown, schema: ToolConfigSchema | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'config must be an object');
  const record = value as Record<string, unknown>;
  if (!schema && Object.keys(record).length) throw new HttpError(400, 'This tool has no configurable fields');
  const validated: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(record)) {
    const rule = schema?.[field];
    if (!rule) throw new HttpError(400, `Unknown tool config field: ${field}`);
    if (rule.type === 'string') {
      if (typeof item !== 'string') throw new HttpError(400, `config.${field} must be a string`);
      validated[field] = item;
      continue;
    }
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new HttpError(400, `config.${field} must be a number`);
    if (rule.min !== undefined && item < rule.min) throw new HttpError(400, `config.${field} must be at least ${rule.min}`);
    if (rule.max !== undefined && item > rule.max) throw new HttpError(400, `config.${field} must be at most ${rule.max}`);
    validated[field] = item;
  }
  return validated;
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
  const historyIndex: GatewayHistoryIndex | false = options.history ?? (options.sessions ? false : {
    upsertSession: upsertHistorySession,
    appendMessage: appendHistoryMessage,
  });
  const authSessions = options.authSessions ?? new AuthSessionStore();
  const loginLocks = options.loginLocks ?? new LoginLockStore();
  const confirmations = options.confirmations ?? new ConfirmationBroker();
  const configState = options.configState ?? { load: loadConfig, save: saveConfig };
  const uploadsDirectory = resolve(options.uploadsDirectory ?? getPaths().uploads);
  const taiweiPaths = getPaths();
  const skillLoader = options.skillLoader ?? new SkillLoader();
  const toolRegistry = options.toolRegistry;
  const knowledgeDirectory = resolve(options.knowledgeDirectory ?? taiweiPaths.knowledge);
  const ragIndexPath = resolve(options.ragIndexPath ?? taiweiPaths.ragIndex);
  const memoryDirectory = resolve(options.memoryDirectory ?? taiweiPaths.memoryDir);
  const mcpConfigPath = resolve(options.mcpConfigPath ?? taiweiPaths.mcp);
  const memoryStore = options.memoryStore ?? new MemoryStore();
  let mcpInitialized = false;
  const buildKnowledgeIndex = options.buildKnowledgeIndex ?? (async () => buildIndex(createEmbedder(await configState.load())));
  const searchKnowledge = options.searchKnowledge ?? (async (query: string, limit: number) => retrieve(query, limit, createEmbedder(await configState.load())));
  const authEnabled = options.auth?.enabled ?? false;
  if (authEnabled && !options.auth?.password) {
    throw new Error('Gateway auth is enabled but no password is set. Set auth.password in ~/.taiwei/config.json or TAIWEI_AUTH_PASSWORD.');
  }
  const log = options.log ?? console.log;
  const modelState: GatewayModelState = options.modelState ?? { getCurrentModel, resolveModels, setCurrentModel };
  const contextWindowFor = options.contextWindow ?? (async (model: string) => resolveContextWindow(await loadConfig(), model));
  const requireMcpBridge = () => {
    if (!options.mcpBridge) throw new HttpError(503, 'MCP bridge is unavailable');
    return options.mcpBridge;
  };
  const mcpSnapshot = async (reload = false) => {
    const bridge = requireMcpBridge();
    if (reload || !mcpInitialized) {
      await bridge.reload();
      mcpInitialized = true;
    }
    const servers = await loadMcpConfig(mcpConfigPath);
    return { servers: servers.map(publicMcpServer), statuses: bridge.list() };
  };
  const saveMcpServers = async (servers: McpServerConfig[]) => {
    await mkdir(dirname(mcpConfigPath), { recursive: true });
    await writeFile(mcpConfigPath, `${JSON.stringify(servers, null, 2)}\n`, 'utf8');
  };
  const allSkills = async (config: TaiweiConfig): Promise<Skill[]> => {
    skillLoader.setDisabled?.(config.skillsDisabled);
    return skillLoader.list({ includeDisabled: true });
  };
  const toolSnapshot = async () => {
    if (!toolRegistry) throw new HttpError(503, 'Tool registry is unavailable');
    const config = await configState.load();
    toolRegistry.configure(config.tools);
    return { tools: toolRegistry.list({ includeDisabled: true }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      enabled: toolRegistry.isEnabled(tool.name),
      configurable: Boolean(tool.configSchema && Object.keys(tool.configSchema).length),
      ...(tool.configSchema ? { configSchema: tool.configSchema } : {}),
      config: toolRegistry.getConfig(tool.name),
    })) };
  };
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
        const accessConfig = await configState.load();
        if (!authEnabled && !accessConfig.guests.length) {
          json(response, 404, { error: 'Authentication is disabled' });
          return;
        }
        const body = await readJson(request) as { username?: unknown; password?: unknown };
        const ip = request.socket.remoteAddress ?? 'unknown';
        const attemptedUsername = typeof body?.username === 'string' ? body.username : '';
        const configuredPassword = options.auth?.password ?? '';
        const adminValid = authEnabled && typeof body?.username === 'string'
          && typeof body?.password === 'string'
          && constantTimeEqual(body.username, options.auth?.username ?? '')
          && verifyPassword(body.password, configuredPassword);
        const guest = typeof body?.username === 'string' && typeof body?.password === 'string'
          ? accessConfig.guests.find((item) => constantTimeEqual(body.username as string, item.username) && verifyPassword(body.password as string, item.password))
          : undefined;
        const valid = adminValid || Boolean(guest);
        const attempt = await loginLocks.attempt(attemptedUsername, ip, valid);
        if (attempt.lock) {
          log(`[taiwei] Warning: login lock ${attempt.lock} reached for ${ip} (${attemptedUsername || '<empty>'})`);
          json(response, 429, { error: lockMessage(attempt.lock) });
          return;
        }
        if (attempt.failed) {
          json(response, 401, { error: 'Invalid username or password' });
          return;
        }
        if (adminValid && !options.authPasswordFromEnvironment && !isScryptPassword(configuredPassword)) {
          const migratedPassword = hashPassword(body.password as string);
          const config = await configState.load();
          if (config.auth.password === configuredPassword) {
            config.auth.password = migratedPassword;
            await configState.save(config);
          }
          if (options.auth) options.auth.password = migratedPassword;
        }
        if (guest && !isScryptPassword(guest.password)) {
          const current = accessConfig.guests.find((item) => item.username === guest.username);
          if (current) current.password = hashPassword(body.password as string);
          await configState.save(accessConfig);
        }
        const role = adminValid ? 'admin' : 'guest';
        const username = adminValid ? body.username as string : guest!.username;
        const token = await authSessions.create(username, role);
        json(response, 200, { token, role, username }, { 'set-cookie': sessionCookie(token) });
        return;
      }
      let authenticatedToken: string | undefined;
      let authenticatedUsername: string | undefined;
      let authenticatedRole: 'admin' | 'guest' = 'admin';
      let guestId: string | undefined;
      const accessConfig = await configState.load();
      const presentedToken = requestToken(request) ?? requestShareToken(request);
      const authRequired = authEnabled || Boolean(presentedToken);
      if (authRequired && pathname.startsWith('/api/')) {
        authenticatedToken = requestToken(request);
        const authenticated = authenticatedToken ? await authSessions.authenticate(authenticatedToken) : undefined;
        if (authenticated) {
          authenticatedUsername = authenticated.username;
          authenticatedRole = authenticated.role ?? 'admin';
          if (authenticatedRole === 'guest') guestId = guestIdForUsername(authenticated.username);
        } else {
          const shareToken = requestShareToken(request) ?? authenticatedToken;
          if (accessConfig.share.enabled && shareToken && constantTimeEqual(shareToken, accessConfig.share.token)) {
            authenticatedRole = 'guest';
            authenticatedUsername = '访客';
            guestId = `guest-${shareToken.slice(0, 8).toLowerCase()}`;
            authenticatedToken = undefined;
          } else {
          json(response, 401, { error: 'unauthorized' });
          return;
          }
        }
        if (authenticatedRole === 'guest' && !guestRouteAllowed(method, pathname)) {
          json(response, 403, { error: 'forbidden' });
          return;
        }
      }
      const activeSessions = guestId
        ? new SessionStore(join(taiweiPaths.guests, guestId, 'sessions'))
        : sessions;
      const turnMemory = guestId ? MemoryStore.forGuest(guestId) : undefined;
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
          role: authenticatedRole,
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
      if (method === 'GET' && pathname === '/api/settings/custom-prompt') {
        const config = await configState.load();
        json(response, 200, { customPrompt: config.customPrompt });
        return;
      }
      if (method === 'GET' && pathname === '/api/memory') {
        const content = await memoryStore.read();
        await mkdir(memoryDirectory, { recursive: true });
        const extended = await Promise.all((await readdir(memoryDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map(async (entry) => ({ name: entry.name.slice(0, -3), chars: (await readFile(join(memoryDirectory, entry.name), 'utf8')).length })));
        const indexStatus = await knowledgeIndexStatus(ragIndexPath);
        json(response, 200, { content, core: { content, ...memoryStats(content) }, extended, indexStatus: { exists: indexStatus.exists, chunks: indexStatus.chunks, hasVectors: indexStatus.hasVectors }, ...memoryStats(content) });
        return;
      }
      if (method === 'POST' && pathname === '/api/memory') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be an object');
        const { content } = body as { content?: unknown };
        if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
        if (content.length > MAX_MEMORY_LENGTH) throw new HttpError(413, `content must be at most ${MAX_MEMORY_LENGTH} characters`);
        await memoryStore.replace(content);
        json(response, 200, memoryStats(content));
        return;
      }
      if (method === 'DELETE' && pathname === '/api/memory') {
        await memoryStore.clear();
        json(response, 200, { ok: true });
        return;
      }
      if (method === 'DELETE' && pathname === '/api/memory/extended') {
        const name = new URL(request.url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new HttpError(400, 'name must match [A-Za-z0-9_-]{1,32}');
        const target = resolve(memoryDirectory, `${name}.md`);
        if (!withinDirectory(target, memoryDirectory)) throw new HttpError(400, '扩展记忆路径无效');
        await unlink(target).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, '扩展记忆不存在');
          throw error;
        });
        json(response, 200, { ok: true });
        return;
      }
      if (method === 'GET' && pathname === '/api/share') {
        const config = await configState.load();
        const host = request.headers.host ?? `${config.gateway.host}:${config.gateway.port}`;
        const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        json(response, 200, { ...config.share, url: config.share.token ? `${protocol}://${host}/?share=${encodeURIComponent(config.share.token)}` : '' });
        return;
      }
      if (method === 'POST' && pathname === '/api/share') {
        const config = await configState.load();
        config.share = { enabled: true, token: randomBytes(16).toString('hex'), createdAt: new Date().toISOString() };
        await configState.save(config);
        const host = request.headers.host ?? `${config.gateway.host}:${config.gateway.port}`;
        const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        json(response, 200, { ...config.share, url: `${protocol}://${host}/?share=${config.share.token}` });
        return;
      }
      if (method === 'DELETE' && pathname === '/api/share') {
        const config = await configState.load();
        config.share.enabled = false;
        await configState.save(config);
        json(response, 200, { ok: true });
        return;
      }
      if (method === 'GET' && pathname === '/api/guests') {
        const config = await configState.load();
        json(response, 200, config.guests.map(({ username, createdAt }) => ({ username, createdAt })));
        return;
      }
      if (method === 'POST' && pathname === '/api/guests') {
        const body = await readJson(request) as { username?: unknown; password?: unknown };
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        if (!/^[A-Za-z0-9_-]{2,32}$/.test(username)) throw new HttpError(400, 'username must match [A-Za-z0-9_-]{2,32}');
        if (typeof body.password !== 'string' || body.password.length < 4) throw new HttpError(400, 'password must contain at least 4 characters');
        const config = await configState.load();
        if (config.guests.some((item) => item.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'guest username already exists');
        const guest = { username, password: hashPassword(body.password), createdAt: new Date().toISOString() };
        config.guests.push(guest);
        await configState.save(config);
        json(response, 201, { username, createdAt: guest.createdAt });
        return;
      }
      if (method === 'DELETE' && pathname === '/api/guests') {
        const username = new URL(request.url ?? '/', 'http://localhost').searchParams.get('username') ?? '';
        const config = await configState.load();
        const index = config.guests.findIndex((item) => item.username === username);
        if (index < 0) throw new HttpError(404, 'guest account not found');
        config.guests.splice(index, 1);
        await configState.save(config);
        json(response, 200, { ok: true });
        return;
      }
      if (method === 'POST' && pathname === '/api/settings/custom-prompt') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be an object');
        const { customPrompt } = body as { customPrompt?: unknown };
        if (typeof customPrompt !== 'string') throw new HttpError(400, 'customPrompt must be a string');
        if (customPrompt.length > MAX_CUSTOM_PROMPT_LENGTH) throw new HttpError(400, `customPrompt must be at most ${MAX_CUSTOM_PROMPT_LENGTH} characters`);
        const config = await configState.load();
        config.customPrompt = customPrompt;
        await configState.save(config);
        json(response, 200, { customPrompt: config.customPrompt });
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
      if (method === 'GET' && pathname === '/api/mcp') {
        json(response, 200, await mcpSnapshot());
        return;
      }
      if (method === 'POST' && pathname === '/api/mcp/reload') {
        json(response, 200, await mcpSnapshot(true));
        return;
      }
      if (method === 'POST' && pathname === '/api/mcp/test') {
        const body = await readJson(request) as { name?: unknown };
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new HttpError(400, 'name must match [A-Za-z0-9_-]{1,32}');
        const server = (await loadMcpConfig(mcpConfigPath)).find((item) => item.name === name);
        if (!server) throw new HttpError(404, `MCP server not found: ${name}`);
        json(response, 200, await requireMcpBridge().test(server));
        return;
      }
      if (method === 'POST' && pathname === '/api/mcp') {
        const body = await readJson(request);
        const incoming = validateMcpServer(body);
        const servers = await loadMcpConfig(mcpConfigPath);
        const index = servers.findIndex((item) => item.name === incoming.name);
        const existing = index >= 0 ? servers[index] : undefined;
        const envProvided = Object.prototype.hasOwnProperty.call(body, 'env');
        const submittedEnv = incoming.env ?? {};
        let env: Record<string, string> | undefined;
        if (existing) {
          if (!envProvided || (Object.keys(submittedEnv).length === 0 && existing.env)) env = existing.env;
          else if (incoming.preserveEnv) env = { ...existing.env, ...submittedEnv };
          else env = submittedEnv;
        } else if (envProvided) env = submittedEnv;
        const { preserveEnv: _preserveEnv, env: _incomingEnv, ...safeIncoming } = incoming;
        const next: McpServerConfig = { ...safeIncoming, ...(env ? { env } : {}) };
        if (index >= 0) servers[index] = next;
        else servers.push(next);
        await saveMcpServers(servers);
        json(response, index >= 0 ? 200 : 201, await mcpSnapshot(true));
        return;
      }
      if (method === 'DELETE' && pathname === '/api/mcp') {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const name = (url.searchParams.get('name') ?? '').trim();
        if (!name) throw new HttpError(400, 'name is required');
        const servers = await loadMcpConfig(mcpConfigPath);
        const index = servers.findIndex((item) => item.name === name);
        if (index < 0) throw new HttpError(404, `MCP server not found: ${name}`);
        servers.splice(index, 1);
        await saveMcpServers(servers);
        const snapshot = await mcpSnapshot(true);
        json(response, 200, { ok: true, ...snapshot });
        return;
      }
      if (method === 'GET' && pathname === '/api/skills') {
        const config = await configState.load();
        const skills = await allSkills(config);
        json(response, 200, { skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          enabled: !(skillLoader.isDisabled?.(skill) ?? config.skillsDisabled?.includes(skill.name)),
        })) });
        return;
      }
      const skillRoute = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillRoute && (method === 'GET' || method === 'POST')) {
        let name: string;
        try { name = decodeURIComponent(skillRoute[1]); }
        catch { throw new HttpError(400, '技能名称编码无效'); }
        const config = await configState.load();
        const skills = await allSkills(config);
        const skill = skills.find((item) => item.name === name || item.path.split('/').at(-2) === name);
        if (!skill) throw new HttpError(404, `技能不存在：${name}`);
        if (method === 'POST') {
          const body = await readJson(request) as { enabled?: unknown };
          if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
          const aliases = new Set([name, skill.name, skill.path.split('/').at(-2) ?? '']);
          const disabled = new Set(config.skillsDisabled ?? []);
          if (body.enabled) for (const alias of aliases) disabled.delete(alias);
          else disabled.add(skill.name);
          config.skillsDisabled = [...disabled].sort();
          await configState.save(config);
          skillLoader.setDisabled?.(config.skillsDisabled);
          json(response, 200, { ok: true, enabled: body.enabled });
          return;
        }
        json(response, 200, { name: skill.name, description: skill.description, content: await readFile(skill.path, 'utf8') });
        return;
      }
      if (method === 'GET' && pathname === '/api/tools') {
        json(response, 200, await toolSnapshot());
        return;
      }
      if (method === 'POST' && pathname === '/api/tools/reload') {
        json(response, 200, await toolSnapshot());
        return;
      }
      const toolRoute = pathname.match(/^\/api\/tools\/([^/]+)$/);
      if (method === 'POST' && toolRoute) {
        if (!toolRegistry) throw new HttpError(503, 'Tool registry is unavailable');
        let name: string;
        try { name = decodeURIComponent(toolRoute[1]); }
        catch { throw new HttpError(400, '工具名称编码无效'); }
        const tool = toolRegistry.get(name);
        if (!tool) throw new HttpError(404, `Tool not found: ${name}`);
        const body = await readJson(request) as { enabled?: unknown; config?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be an object');
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
        const toolConfig = body.config === undefined ? {} : validateToolConfig(body.config, tool.configSchema);
        const config = await configState.load();
        const previous = config.tools?.[name] ?? {};
        config.tools = {
          ...config.tools,
          [name]: {
            ...previous,
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...toolConfig,
          },
        };
        await configState.save(config);
        toolRegistry.configure(config.tools);
        json(response, 200, { ok: true, enabled: toolRegistry.isEnabled(name), config: toolRegistry.getConfig(name) });
        return;
      }
      if (method === 'GET' && pathname === '/api/knowledge') {
        await mkdir(knowledgeDirectory, { recursive: true });
        json(response, 200, { files: await walkKnowledge(knowledgeDirectory), index: await knowledgeIndexStatus(ragIndexPath) });
        return;
      }
      if (method === 'POST' && pathname === '/api/knowledge/rebuild') {
        await mkdir(knowledgeDirectory, { recursive: true });
        let index: RagIndexData;
        try { index = await buildKnowledgeIndex(); }
        catch (error) { throw new HttpError(500, `重建知识库索引失败：${(error as Error).message}`); }
        if (!index.chunks.length) throw new HttpError(400, '知识库文件中没有可索引的内容');
        json(response, 200, {
          ok: true,
          chunks: index.chunks.length,
          hasVectors: Boolean(index.vectors?.length),
          embedModel: index.embedModel ?? null,
        });
        return;
      }
      if (method === 'GET' && pathname === '/api/knowledge/search') {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const query = (url.searchParams.get('q') ?? '').trim();
        if (!query) throw new HttpError(400, 'q 不能为空');
        const requestedLimit = Number(url.searchParams.get('limit') ?? 5);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20) throw new HttpError(400, 'limit 必须是 1 到 20 的整数');
        const results = await searchKnowledge(query, requestedLimit);
        json(response, 200, { results: results.map(({ text, score }) => ({ text, score })) });
        return;
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
        return;
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
        json(response, 200, await activeSessions.list());
        return;
      }
      if (method === 'POST' && pathname === '/api/sessions') {
        json(response, 201, await activeSessions.create());
        return;
      }
      const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionRoute && method === 'GET') {
        const session = await activeSessions.get(decodeURIComponent(sessionRoute[1]));
        if (!session) json(response, 404, { error: 'Session not found' });
        else json(response, 200, session);
        return;
      }
      if (sessionRoute && method === 'DELETE') {
        const deleted = await activeSessions.delete(decodeURIComponent(sessionRoute[1]));
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
        const session = typeof body.sessionId === 'string' ? await activeSessions.get(body.sessionId) : await activeSessions.create();
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
        const history = activeSessions.toChatHistory(session);
        const activeModel = await modelState.getCurrentModel();
        const activeContextWindow = await contextWindowFor(activeModel);
        if (!session.messages.some((item) => item.role === 'user')) session.title = activeSessions.titleFrom(message) || session.title;
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
                contextWindow: event.usage.contextWindow ?? activeContextWindow,
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
        }, history, session.id, turnMemory);
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
        await activeSessions.save(session);
        if (historyIndex && !guestId) {
          try {
            await historyIndex.upsertSession({
              id: session.id, title: session.title, source: 'gateway', model: session.usage?.model,
              createdAt: session.createdAt, updatedAt: session.updatedAt,
            });
            for (const storedMessage of session.messages) {
              await historyIndex.appendMessage({
                sessionId: session.id, role: storedMessage.role, content: storedMessage.content,
                timestamp: storedMessage.timestamp,
              });
              for (const tool of storedMessage.toolCalls ?? []) {
                await historyIndex.appendMessage({
                  sessionId: session.id, role: 'tool', content: tool.result ?? '', toolName: tool.name,
                  timestamp: storedMessage.timestamp,
                });
              }
            }
          } catch (error) {
            log(`[taiwei] history index update skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
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
