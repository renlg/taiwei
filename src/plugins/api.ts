import type { ToolDefinition } from '../llm/tools.js';
import type { ToolContext } from '../tools/registry.js';
import type { PolicyDecision } from '../security/policy.js';

export interface PluginToolDef extends ToolDefinition {}
export type PluginToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown;

export interface PluginManifest {
  name: string;
  version: string;
  apiVersion: 1;
  description?: string;
  author?: string;
  capabilities: string[];
  configSchema?: Record<string, unknown>;
  tools?: PluginToolDef[];
  skills?: string[];
  main: string;
}

export interface PluginRuntimeApi {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  registerTool(definition: PluginToolDef, handler: PluginToolHandler): void;
  registerSkill(path: string): Promise<void>;
  readonly config: Readonly<Record<string, unknown>>;
  policyCheck(tool: string, args: Record<string, unknown>): PolicyDecision;
}

export interface PluginModule {
  init?(api: PluginRuntimeApi): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
