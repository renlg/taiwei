import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, expandHome, resolveWorkspaceDir, type TaiweiConfig } from '../../config/config.js';
import { DEFAULT_DANGER_PATTERNS } from '../../security/commands.js';
import { HOOK_EVENTS, HookRunner, type HookEvent } from '../../hooks/runner.js';
import { HttpError, json, readJson, withinDirectory } from '../http.js';
import { validateHooks, sampleHookFields } from '../hooks-helpers.js';
import { knowledgeIndexStatus } from '../knowledge-helpers.js';
import type { RouteContext } from './route-context.js';

const MAX_CUSTOM_PROMPT_LENGTH = 20_000;
const MAX_MEMORY_LENGTH = 50_000;

function memoryStats(content: string): { chars: number; lines: number } {
  return { chars: content.length, lines: content ? content.split(/\r\n|\r|\n/).length : 0 };
}

/** Handles /api/settings*, /api/memory*, /api/share, /api/hooks/test, and /api/plugins*. */
export async function handleSettingsRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { options, configState, memoryStore, memoryDirectory, ragIndexPath, log } = runtime;

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
    return true;
  }
  if (method === 'GET' && pathname === '/api/plugins') {
    if (!options.pluginLoader) throw new HttpError(503, 'Plugin loader is unavailable');
    json(response, 200, { plugins: options.pluginLoader.list() }); return true;
  }
  const pluginRoute = pathname.match(/^\/api\/plugins\/([^/]+)$/);
  if (method === 'POST' && pluginRoute) {
    if (!options.pluginLoader) throw new HttpError(503, 'Plugin loader is unavailable');
    const body = await readJson(request) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
    await options.pluginLoader.setEnabled(decodeURIComponent(pluginRoute[1]), body.enabled);
    json(response, 200, { ok: true, plugins: options.pluginLoader.list() }); return true;
  }
  if (method === 'GET' && pathname === '/api/settings/custom-prompt') {
    const config = await configState.load();
    json(response, 200, { customPrompt: config.customPrompt });
    return true;
  }
  if (method === 'GET' && pathname === '/api/memory') {
    const content = await memoryStore.read();
    await mkdir(memoryDirectory, { recursive: true });
    const extended = await Promise.all((await readdir(memoryDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map(async (entry) => ({ name: entry.name.slice(0, -3), chars: (await readFile(join(memoryDirectory, entry.name), 'utf8')).length })));
    const indexStatus = await knowledgeIndexStatus(ragIndexPath);
    json(response, 200, { content, core: { content, ...memoryStats(content) }, extended, indexStatus: { exists: indexStatus.exists, chunks: indexStatus.chunks, hasVectors: indexStatus.hasVectors }, ...memoryStats(content) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/memory') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be an object');
    const { content } = body as { content?: unknown };
    if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
    if (content.length > MAX_MEMORY_LENGTH) throw new HttpError(413, `content must be at most ${MAX_MEMORY_LENGTH} characters`);
    await memoryStore.replace(content);
    json(response, 200, memoryStats(content));
    return true;
  }
  if (method === 'DELETE' && pathname === '/api/memory') {
    await memoryStore.clear();
    json(response, 200, { ok: true });
    return true;
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
    return true;
  }
  if (method === 'GET' && pathname === '/api/share') {
    const config = await configState.load();
    const host = request.headers.host ?? `${config.gateway.host}:${config.gateway.port}`;
    const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    json(response, 200, { ...config.share, url: config.share.token ? `${protocol}://${host}/?share=${encodeURIComponent(config.share.token)}` : '' });
    return true;
  }
  if (method === 'POST' && pathname === '/api/share') {
    const config = await configState.load();
    config.share = { enabled: true, token: randomBytes(16).toString('hex'), createdAt: new Date().toISOString() };
    await configState.save(config);
    const host = request.headers.host ?? `${config.gateway.host}:${config.gateway.port}`;
    const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    json(response, 200, { ...config.share, url: `${protocol}://${host}/?share=${config.share.token}` });
    return true;
  }
  if (method === 'DELETE' && pathname === '/api/share') {
    const config = await configState.load();
    config.share.enabled = false;
    await configState.save(config);
    json(response, 200, { ok: true });
    return true;
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
    return true;
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
    return true;
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
    return true;
  }
  return false;
}
