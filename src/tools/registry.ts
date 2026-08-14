import type { ToolDefinition } from '../llm/tools.js';
import type { HookRunner } from '../hooks/runner.js';
import type { ToolSettings } from '../config/config.js';
import type { AgentContext } from '../agent/context.js';
import type { AgentProfile } from '../agents/profiles.js';
import { toolDenied } from '../agents/profiles.js';

export interface ToolConfigField {
  type: 'number' | 'string';
  default: number | string;
  label: string;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

export type ToolConfigSchema = Record<string, ToolConfigField>;

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;
  authorizeCommand?: (command: string, cwd: string) => Promise<boolean>;
  hooks?: HookRunner;
  sessionId?: string;
  /** The conversation owning this dispatch; session-aware tools must mutate this context, not global app state. */
  agentContext?: AgentContext;
  /** Runtime-only settings supplied by ToolRegistry; these are never exposed as LLM arguments. */
  toolConfig?: Readonly<Record<string, unknown>>;
  agentProfile?: AgentProfile;
  delegationDepth?: number;
}

export interface ToolSpec extends ToolDefinition {
  configSchema?: ToolConfigSchema;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  // Kept independently from registrations so unregister/re-register reloads retain dynamic tool state.
  private settings = new Map<string, ToolSettings>();

  configure(settings: Record<string, ToolSettings> = {}): void {
    this.settings = new Map(Object.entries(settings).map(([name, value]) => [name, { ...value }]));
  }

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

  get(name: string): ToolSpec | undefined { return this.tools.get(name); }

  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.tools.has(name)) return false;
    this.settings.set(name, { ...this.settings.get(name), enabled });
    return true;
  }

  isEnabled(name: string): boolean { return this.tools.has(name) && this.settings.get(name)?.enabled !== false; }

  getConfig(name: string): Record<string, unknown> {
    const tool = this.tools.get(name);
    if (!tool?.configSchema) return {};
    const stored = this.settings.get(name) ?? {};
    return Object.fromEntries(Object.entries(tool.configSchema).map(([field, schema]) => [
      field,
      Object.prototype.hasOwnProperty.call(stored, field) ? stored[field] : schema.default,
    ]));
  }

  list(options: { includeDisabled?: boolean; profile?: AgentProfile } = {}): ToolSpec[] {
    const tools = [...this.tools.values()];
    return (options.includeDisabled ? tools : tools.filter((tool) => this.isEnabled(tool.name))).filter((tool) => !toolDenied(tool.name, options.profile));
  }

  async dispatch(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
    if (!this.isEnabled(name)) return JSON.stringify({ error: `Tool "${name}" is disabled` });
    if (toolDenied(name, context.agentProfile)) return JSON.stringify({ error: `Tool "${name}" is denied by agent profile "${context.agentProfile?.id}"` });
    const hook = await context.hooks?.run('beforeTool', { sessionId: context.sessionId, tool: name, args, cwd: context.cwd });
    if (hook?.block) {
      const output = JSON.stringify({ error: '用户拒绝了该命令的执行', blockedByHook: hook.reason });
      await context.hooks?.run('afterTool', { sessionId: context.sessionId, tool: name, args, ok: false, resultPreview: output.slice(0, 1_000) });
      return output;
    }
    let output: string;
    let ok = true;
    try {
      const value = await tool.execute(args, { ...context, toolConfig: this.getConfig(name) });
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
