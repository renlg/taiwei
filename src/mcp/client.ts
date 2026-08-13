import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ensureTaiweiHome } from '../util/paths.js';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpConnection { config: McpServerConfig; client: Client; toolNames: string[]; }

export async function loadMcpConfig(): Promise<McpServerConfig[]> {
  const { mcp } = await ensureTaiweiHome();
  try {
    const value = JSON.parse(await readFile(mcp, 'utf8')) as unknown;
    if (!Array.isArray(value)) throw new Error('root value must be an array');
    return value.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`entry ${index} must be an object`);
      const config = item as Partial<McpServerConfig>;
      if (!config.name || !['stdio', 'sse'].includes(config.transport ?? '')) throw new Error(`entry ${index} requires name and transport`);
      return { ...config, enabled: config.enabled !== false } as McpServerConfig;
    });
  } catch (error) { throw new Error(`Invalid MCP config: ${(error as Error).message}`); }
}

export async function connectServer(config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: 'taiwei', version: '0.1.0' });
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error(`MCP server ${config.name} requires command`);
    const params: StdioServerParameters = { command: config.command, args: config.args, env: config.env };
    await client.connect(new StdioClientTransport(params));
  } else {
    if (!config.url) throw new Error(`MCP server ${config.name} requires url`);
    await client.connect(new SSEClientTransport(new URL(config.url)));
  }
  const listed = await client.listTools();
  return { config, client, toolNames: listed.tools.map((tool) => tool.name) };
}
