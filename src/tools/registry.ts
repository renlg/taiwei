import type { ToolDefinition } from '../llm/tools.js';

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;
}

export interface ToolSpec extends ToolDefinition {
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(tool: ToolSpec, replace = false): void {
    if (!replace && this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  unregisterPrefix(prefix: string): void {
    for (const name of this.tools.keys()) if (name.startsWith(prefix)) this.tools.delete(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  async dispatch(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
    try {
      const value = await tool.execute(args, context);
      if (typeof value === 'string') return value;
      return JSON.stringify(value ?? null);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}
