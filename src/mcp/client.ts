import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ensureTaiweiHome } from '../util/paths.js';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpConnection { config: McpServerConfig; client: Client; toolNames: string[]; }

export function streamableHttpOptions(config: Pick<McpServerConfig, 'headers'>): ConstructorParameters<typeof StreamableHTTPClientTransport>[1] {
  return {
    requestInit: { headers: { accept: 'application/json, text/event-stream', ...config.headers } },
    reconnectionOptions: { initialReconnectionDelay: 500, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 2, maxRetries: 5 },
  };
}

export async function loadMcpConfig(path?: string): Promise<McpServerConfig[]> {
  const mcp = path ?? (await ensureTaiweiHome()).mcp;
  try {
    const value = JSON.parse(await readFile(mcp, 'utf8')) as unknown;
    if (!Array.isArray(value)) throw new Error('root value must be an array');
    return value.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`entry ${index} must be an object`);
      const config = item as Partial<McpServerConfig>;
      if (!config.name || !['stdio', 'sse', 'streamable-http'].includes(config.transport ?? '')) throw new Error(`entry ${index} requires name and transport`);
      return { ...config, enabled: config.enabled !== false } as McpServerConfig;
    });
  } catch (error) { throw new Error(`Invalid MCP config: ${(error as Error).message}`); }
}

export async function connectServer(config: McpServerConfig, onToolsChanged?: (error: Error | null, tools: Tool[] | null) => void): Promise<McpConnection> {
  const client = new Client({ name: 'taiwei', version: '0.1.0' }, onToolsChanged ? { listChanged: { tools: { onChanged: onToolsChanged } } } : undefined);
  try {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`MCP server ${config.name} requires command`);
      const params: StdioServerParameters = { command: config.command, args: config.args, env: config.env };
      await client.connect(new StdioClientTransport(params));
    } else if (config.transport === 'sse') {
      if (!config.url) throw new Error(`MCP server ${config.name} requires url`);
      await client.connect(new SSEClientTransport(new URL(config.url)));
    } else {
      if (!config.url) throw new Error(`MCP server ${config.name} requires url`);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), streamableHttpOptions(config)));
    }
    const listed = await client.listTools();
    return { config, client, toolNames: listed.tools.map((tool) => tool.name) };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
