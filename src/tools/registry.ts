import type { ToolDefinition } from '../llm/tools.js';
import type { HookRunner } from '../hooks/runner.js';

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;
  authorizeCommand?: (command: string, cwd: string) => Promise<boolean>;
  hooks?: HookRunner;
  sessionId?: string;
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
    const hook = await context.hooks?.run('beforeTool', { sessionId: context.sessionId, tool: name, args, cwd: context.cwd });
    if (hook?.block) {
      const output = JSON.stringify({ error: '用户拒绝了该命令的执行', blockedByHook: hook.reason });
      await context.hooks?.run('afterTool', { sessionId: context.sessionId, tool: name, args, ok: false, resultPreview: output.slice(0, 1_000) });
      return output;
    }
    let output: string;
    let ok = true;
    try {
      const value = await tool.execute(args, context);
      output = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      try { ok = !(JSON.parse(output) as { error?: unknown })?.error; } catch {}
    } catch (error) {
      ok = false;
      output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
    await context.hooks?.run('afterTool', { sessionId: context.sessionId, tool: name, args, ok, resultPreview: output.slice(0, 1_000) });
    return output;
  }
}
