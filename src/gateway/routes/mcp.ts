import { loadMcpConfig, type McpServerConfig } from '../../mcp/client.js';
import { HttpError, json, readJson } from '../http.js';
import { validateMcpServer } from '../mcp-config.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/mcp* CRUD and test routes. */
export async function handleMcpRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { mcpConfigPath, mcpSnapshot, saveMcpServers, requireMcpBridge } = runtime;
  if (!pathname.startsWith('/api/mcp')) return false;
  if (method === 'GET' && pathname === '/api/mcp') {
    json(response, 200, await mcpSnapshot());
    return true;
  }
  if (method === 'POST' && pathname === '/api/mcp/reload') {
    json(response, 200, await mcpSnapshot(true));
    return true;
  }
  if (method === 'POST' && pathname === '/api/mcp/test') {
    const body = await readJson(request) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new HttpError(400, 'name must match [A-Za-z0-9_-]{1,32}');
    const server = (await loadMcpConfig(mcpConfigPath)).find((item) => item.name === name);
    if (!server) throw new HttpError(404, `MCP server not found: ${name}`);
    json(response, 200, await requireMcpBridge().test(server));
    return true;
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
    return true;
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
    return true;
  }
  return false;
}
