import { resolveToolSettings } from '../../config/config.js';
import { HttpError, json, readJson } from '../http.js';
import { validateToolConfig } from '../mcp-config.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/tools* routes. */
export async function handleToolRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { toolRegistry, toolSnapshot, configState } = runtime;
  if (method === 'GET' && pathname === '/api/tools') {
    json(response, 200, await toolSnapshot());
    return true;
  }
  if (method === 'POST' && pathname === '/api/tools/reload') {
    json(response, 200, await toolSnapshot());
    return true;
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
    toolRegistry.configure(resolveToolSettings(config));
    json(response, 200, { ok: true, enabled: toolRegistry.isEnabled(name), config: toolRegistry.getConfig(name) });
    return true;
  }
  return false;
}
