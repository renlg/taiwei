import type { ToolRegistry } from '../tools/registry.js';
import { connectServer, loadMcpConfig, type McpConnection, type McpServerConfig } from './client.js';

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '_'); }

export class McpBridge {
  private connections: McpConnection[] = [];
  private statuses: Array<{ name: string; connected: boolean; detail: string }> = [];
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private reconnectAttempts = new Map<string, number>();
  private reloading = false;
  private closing = false;
  constructor(private readonly registry: ToolRegistry) {}

  async reload(): Promise<void> {
    this.reloading = true; this.closing = false;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer); this.reconnectTimers.clear();
    this.registry.unregisterPrefix('mcp_');
    await Promise.allSettled(this.connections.map((connection) => connection.client.close()));
    this.connections = []; this.statuses = [];
    for (const config of await loadMcpConfig()) {
      if (!config.enabled) { this.statuses.push({ name: config.name, connected: false, detail: 'disabled' }); continue; }
      try {
        const connection = await connectServer(config, (error, tools) => {
          if (error) { this.setStatus(config.name, false, `schema refresh failed: ${error.message}`); return; }
          if (tools) this.registerTools(config, connection, tools);
        });
        const listed = await connection.client.listTools();
        this.registerTools(config, connection, listed.tools);
        connection.client.onclose = () => this.scheduleReconnect(config);
        connection.client.onerror = (error) => this.setStatus(config.name, false, error.message);
        this.connections.push(connection);
        this.statuses.push({ name: config.name, connected: true, detail: `${listed.tools.length} tools` });
      } catch (error) {
        this.statuses.push({ name: config.name, connected: false, detail: (error as Error).message });
      }
    }
    this.reloading = false;
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
  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer); this.reconnectTimers.clear();
    await Promise.allSettled(this.connections.map((connection) => connection.client.close()));
  }
  private registerTools(config: McpServerConfig, connection: McpConnection, tools: Array<{ name: string; description?: string; inputSchema: object }>): void {
    this.registry.unregisterPrefix(`mcp_${safeName(config.name)}_`);
    for (const tool of tools) this.registry.register({
      name: `mcp_${safeName(config.name)}_${safeName(tool.name)}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${config.name}`,
      parameters: tool.inputSchema as Record<string, unknown>,
      execute: async (args) => connection.client.callTool({ name: tool.name, arguments: args }),
    });
    connection.toolNames = tools.map((tool) => tool.name);
    this.setStatus(config.name, true, `${tools.length} tools`);
  }
  private setStatus(name: string, connected: boolean, detail: string): void {
    const status = this.statuses.find((item) => item.name === name);
    if (status) Object.assign(status, { connected, detail });
  }
  private scheduleReconnect(config: McpServerConfig): void {
    if (this.closing || this.reloading || config.transport === 'stdio' || this.reconnectTimers.has(config.name)) return;
    const attempt = (this.reconnectAttempts.get(config.name) ?? 0) + 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
    this.reconnectAttempts.set(config.name, attempt); this.setStatus(config.name, false, `reconnecting in ${delay}ms`);
    const timer = setTimeout(() => { this.reconnectTimers.delete(config.name); void this.reconnect(config); }, delay);
    timer.unref?.(); this.reconnectTimers.set(config.name, timer);
  }
  private async reconnect(config: McpServerConfig): Promise<void> {
    if (this.closing || this.reloading) return;
    try {
      const connection = await connectServer(config, (error, tools) => {
        if (error) this.setStatus(config.name, false, `schema refresh failed: ${error.message}`);
        else if (tools) this.registerTools(config, connection, tools);
      });
      const listed = await connection.client.listTools(); this.registerTools(config, connection, listed.tools);
      connection.client.onclose = () => this.scheduleReconnect(config);
      connection.client.onerror = (error) => this.setStatus(config.name, false, error.message);
      const index = this.connections.findIndex((item) => item.config.name === config.name);
      if (index >= 0) this.connections[index] = connection; else this.connections.push(connection);
      this.reconnectAttempts.delete(config.name);
    } catch (error) { this.setStatus(config.name, false, (error as Error).message); this.scheduleReconnect(config); }
  }
}
