import type { ToolDefinition } from '../llm/tools.js';
import type { HookRunner } from '../hooks/runner.js';
import type { ToolSettings } from '../config/config.js';
import type { AgentContext } from '../agent/context.js';
import type { AgentProfile } from '../agents/profiles.js';
import { toolDenied } from '../agents/profiles.js';
import { PolicyEngine, toolPath } from '../security/policy.js';
import { resolveInWorkspace } from '../util/paths.js';
import { appendAudit } from '../observability/audit.js';
import { emitEvent } from '../observability/events.js';

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
  role?: 'admin' | 'guest';
  identity?: string;
  workspaceRoot?: string;
  runId?: string;
  policy?: PolicyEngine;
  workspaceOnly?: boolean;
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
    const role = context.role ?? 'admin';
    const agentMode = context.agentProfile?.mode ?? 'build';
    const sessionId = context.sessionId ?? 'local';
    const runId = context.runId ?? 'unknown';
    const workspaceRoot = context.workspaceRoot ?? context.cwd;
    const decision = (context.policy ?? new PolicyEngine()).decide({
      role, agentMode, sessionId, tool: name, args, cwd: context.cwd, workspaceRoot, identity: context.identity ?? role,
    });
    const policyEvent = { type: 'policy.decision', runId, sessionId, agentId: context.agentProfile?.id, tool: name, outcome: decision.effect, role, agentMode, rule: decision.rule, args } as const;
    emitEvent(policyEvent);
    await appendAudit(policyEvent).catch(() => {});
    if (decision.effect === 'deny') return JSON.stringify({ error: `Tool "${name}" denied by policy`, policy: decision.rule });
    if (toolDenied(name, context.agentProfile)) return JSON.stringify({ error: `Tool "${name}" is denied by agent profile "${context.agentProfile?.id}"` });
    const candidatePath = toolPath(args, context.cwd);
    const workspaceOnly = (role === 'guest' || agentMode === 'plan') && !decision.allowExternalPath;
    if (role === 'guest' && name === 'bash') {
      try { await resolveInWorkspace(context.cwd, workspaceRoot); }
      catch {
        const output = JSON.stringify({ error: 'guest 只能操作自己的工作目录', command: args.command, cwd: context.cwd, policy: 'workspace-boundary' });
        await appendAudit({ type: 'policy.decision', runId, sessionId, tool: name, outcome: 'deny', role, agentMode, rule: 'workspace-boundary', args }).catch(() => {});
        return output;
      }
    }
    if (candidatePath && workspaceOnly) {
      try { await resolveInWorkspace(candidatePath, workspaceRoot); }
      catch (error) {
        const output = JSON.stringify({ error: error instanceof Error ? error.message : String(error), policy: 'workspace-boundary' });
        await appendAudit({ type: 'policy.decision', runId, sessionId, tool: name, outcome: 'deny', role, agentMode, rule: 'workspace-boundary', args }).catch(() => {});
        return output;
      }
    }
    if (decision.effect === 'ask' && (name !== 'bash' || !context.authorizeCommand)) return JSON.stringify({ error: `Tool "${name}" requires confirmation`, policy: decision.rule });
    const hook = await context.hooks?.run('beforeTool', { sessionId: context.sessionId, tool: name, args, cwd: context.cwd });
    if (hook?.block) {
      const output = JSON.stringify({ error: '用户拒绝了该命令的执行', blockedByHook: hook.reason });
      await context.hooks?.run('afterTool', { sessionId: context.sessionId, tool: name, args, ok: false, resultPreview: output.slice(0, 1_000) });
      return output;
    }
    let output: string;
    let ok = true;
    try {
      const started = Date.now();
      const value = await tool.execute(args, { ...context, workspaceRoot, workspaceOnly, toolConfig: this.getConfig(name) });
      output = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      try { ok = !(JSON.parse(output) as { error?: unknown })?.error; } catch {}
      const toolEvent = { type: 'tool.call', runId, sessionId, agentId: context.agentProfile?.id, tool: name, latencyMs: Date.now() - started, outcome: ok ? 'success' : 'error', args } as const;
      emitEvent(toolEvent); await appendAudit(toolEvent).catch(() => {});
    } catch (error) {
      ok = false;
      output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      await appendAudit({ type: 'tool.call', runId, sessionId, agentId: context.agentProfile?.id, tool: name, outcome: 'error', args }).catch(() => {});
    }
    await context.hooks?.run('afterTool', { sessionId: context.sessionId, tool: name, args, ok, resultPreview: output.slice(0, 1_000) });
    return output;
  }
}
