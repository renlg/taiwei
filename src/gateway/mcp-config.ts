import type { McpServerConfig } from '../mcp/client.js';
import type { ToolConfigSchema } from '../tools/registry.js';
import { HttpError } from './http.js';

export type McpPublicServer = Omit<McpServerConfig, 'env' | 'headers'> & { envKeys: string[]; headerKeys?: string[] };

export function publicMcpServer(config: McpServerConfig): McpPublicServer {
  const { env, headers, ...safe } = config;
  return { ...safe, envKeys: Object.keys(env ?? {}), ...(headers ? { headerKeys: Object.keys(headers) } : {}) };
}

export function validateMcpServer(value: unknown): McpServerConfig & { preserveEnv?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'MCP server config must be an object');
  const body = value as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new HttpError(400, 'name must match [A-Za-z0-9_-]{1,32}');
  if (body.transport !== 'stdio' && body.transport !== 'sse' && body.transport !== 'streamable-http') throw new HttpError(400, 'transport must be stdio, sse, or streamable-http');
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (body.transport === 'stdio' && !command) throw new HttpError(400, 'stdio transport requires command');
  if (body.transport === 'sse' || body.transport === 'streamable-http') {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new HttpError(400, 'HTTP transport requires a valid url'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'HTTP url must use http or https');
  }
  if (body.args !== undefined && (!Array.isArray(body.args) || !body.args.every((arg) => typeof arg === 'string'))) {
    throw new HttpError(400, 'args must be an array of strings');
  }
  if (body.env !== undefined && (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)
    || !Object.entries(body.env as Record<string, unknown>).every(([key, item]) => key.trim() && typeof item === 'string'))) {
    throw new HttpError(400, 'env must be an object with non-empty keys and string values');
  }
  if (body.headers !== undefined && (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers)
    || !Object.entries(body.headers as Record<string, unknown>).every(([key, item]) => key.trim() && typeof item === 'string'))) throw new HttpError(400, 'headers must be an object with string values');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
  if (body.preserveEnv !== undefined && typeof body.preserveEnv !== 'boolean') throw new HttpError(400, 'preserveEnv must be boolean');
  return {
    name,
    transport: body.transport,
    ...(body.transport === 'stdio' ? { command } : { url }),
    ...(body.args !== undefined ? { args: [...body.args as string[]] } : {}),
    ...(body.env !== undefined ? { env: { ...body.env as Record<string, string> } } : {}),
    ...(body.headers !== undefined ? { headers: { ...body.headers as Record<string, string> } } : {}),
    enabled: body.enabled !== false,
    ...(body.preserveEnv === true ? { preserveEnv: true } : {}),
  };
}

export function validateToolConfig(value: unknown, schema: ToolConfigSchema | undefined): Record<string, unknown> {
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
