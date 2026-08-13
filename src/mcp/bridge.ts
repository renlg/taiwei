import type { ToolRegistry } from '../tools/registry.js';
import { connectServer, loadMcpConfig, type McpConnection, type McpServerConfig } from './client.js';

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '_'); }

export class McpBridge {
  private connections: McpConnection[] = [];
  private statuses: Array<{ name: string; connected: boolean; detail: string }> = [];
  constructor(private readonly registry: ToolRegistry) {}

  async reload(): Promise<void> {
    this.registry.unregisterPrefix('mcp_');
    await Promise.allSettled(this.connections.map((connection) => connection.client.close()));
    this.connections = []; this.statuses = [];
    for (const config of await loadMcpConfig()) {
      if (!config.enabled) { this.statuses.push({ name: config.name, connected: false, detail: 'disabled' }); continue; }
      try {
        const connection = await connectServer(config);
        const listed = await connection.client.listTools();
        for (const tool of listed.tools) {
          this.registry.register({
            name: `mcp_${safeName(config.name)}_${safeName(tool.name)}`,
            description: tool.description ?? `MCP tool ${tool.name} from ${config.name}`,
            parameters: tool.inputSchema as Record<string, unknown>,
            execute: async (args) => connection.client.callTool({ name: tool.name, arguments: args }),
          });
        }
        this.connections.push(connection);
        this.statuses.push({ name: config.name, connected: true, detail: `${listed.tools.length} tools` });
      } catch (error) {
        this.statuses.push({ name: config.name, connected: false, detail: (error as Error).message });
      }
    }
  }

  list(): Array<{ name: string; connected: boolean; detail: string }> { return [...this.statuses]; }
  async test(config: McpServerConfig): Promise<{ connected: boolean; detail: string }> {
    let connection: McpConnection | undefined;
    try {
      connection = await connectServer(config);
      return { connected: true, detail: `${connection.toolNames.length} tools` };
    } catch (error) {
      return { connected: false, detail: (error as Error).message };
    } finally {
      await connection?.client.close().catch(() => {});
    }
  }
  async close(): Promise<void> { await Promise.allSettled(this.connections.map((connection) => connection.client.close())); }
}
