// Worker entry point for isolated plugin execution.
//
// The main thread sends:
//   { type: 'load', file: string }            — import the plugin module
//   { type: 'execute', id: number, tool: string, args: object }  — call a tool handler
//   { type: 'dispose' }                        — graceful shutdown
//
// The worker replies:
//   { type: 'loaded', tools: Array<{ name, description, parameters }> }
//   { type: 'result', id: number, ok: true, result: unknown }
//   { type: 'result', id: number, ok: false, error: string }
//   { type: 'disposed' }
//   { type: 'error', error: string }           — fatal load/initialisation error

import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PolicyEngine, type PolicyConfig } from '../security/policy.js';

interface PluginModuleLike {
  init?(api: unknown): Promise<void> | void;
  dispose?(): Promise<void> | void;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>, context: Record<string, unknown>) => unknown }>;
  skills?: unknown[];
}

const requirePlugin = createRequire(import.meta.url);
let plugin: PluginModuleLike | null = null;
const handlers = new Map<string, (args: Record<string, unknown>, context: Record<string, unknown>) => unknown>();
const executions = new Map<number, AbortController>();

function post(value: unknown): void { parentPort?.postMessage(value); }

async function loadPlugin(file: string, config: Record<string, unknown>, policyConfig: PolicyConfig, cwd: string, manifestSkillPaths: string[]): Promise<void> {
  const source = await readFile(file, 'utf8');
  let mod: PluginModuleLike;
  if (/\b(?:module\.exports|exports\.|require\s*\()/.test(source)) {
    const resolved = requirePlugin.resolve(file);
    delete requirePlugin.cache[resolved];
    const loaded = requirePlugin(resolved) as PluginModuleLike | { default: PluginModuleLike };
    mod = 'default' in loaded ? loaded.default : loaded;
  } else {
    const loaded = await import(`${pathToFileURL(file).href}?v=${Date.now()}`) as PluginModuleLike & { default?: PluginModuleLike };
    mod = loaded.default ?? loaded;
  }
  plugin = mod;
  // Collect legacy tool definitions.
  const tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
  const skillPaths = new Set(manifestSkillPaths);
  for (const tool of mod.tools ?? []) {
    handlers.set(tool.name, tool.execute);
    tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
  }
  const policy = new PolicyEngine(policyConfig);
  const runtime = {
    log: (level: string, message: string) => post({ type: 'log', level, message }),
    config: Object.freeze({ ...config }),
    registerTool: (definition: { name: string; description: string; parameters: Record<string, unknown> }, handler: (args: Record<string, unknown>, context: Record<string, unknown>) => unknown) => {
      handlers.set(definition.name, handler);
      tools.push({ name: definition.name, description: definition.description, parameters: definition.parameters });
    },
    registerSkill: async (path: string) => { skillPaths.add(path); },
    policyCheck: (tool: string, args: Record<string, unknown>) => policy.decide({
      role: 'admin' as const, agentMode: 'build' as const, sessionId: 'plugin-worker', tool, args,
      cwd, workspaceRoot: cwd, identity: 'plugin-worker',
    }),
  };
  await mod.init?.(runtime);
  post({ type: 'loaded', tools, skillPaths: [...skillPaths], skills: mod.skills ?? [] });
}

async function executeTool(id: number, tool: string, args: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
  const handler = handlers.get(tool);
  if (!handler) { post({ type: 'result', id, ok: false, error: `Unknown tool: ${tool}` }); return; }
  const controller = new AbortController();
  executions.set(id, controller);
  try {
    const result = await handler(args, { ...context, signal: controller.signal });
    post({ type: 'result', id, ok: true, result: result ?? null });
  } catch (error) {
    post({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally { executions.delete(id); }
}

parentPort?.on('message', (message: { type: string; file?: string; id?: number; tool?: string; args?: Record<string, unknown>; context?: Record<string, unknown>; config?: Record<string, unknown>; policyConfig?: PolicyConfig; cwd?: string; skillPaths?: string[] }) => {
  if (message.type === 'load' && message.file) {
    loadPlugin(message.file, message.config ?? {}, message.policyConfig ?? { rules: [] }, message.cwd ?? process.cwd(), message.skillPaths ?? [])
      .catch((error: Error) => post({ type: 'error', error: error.message }));
  } else if (message.type === 'execute' && typeof message.id === 'number' && message.tool) {
    executeTool(message.id, message.tool, message.args ?? {}, message.context ?? {}).catch((error: Error) => post({ type: 'result', id: message.id, ok: false, error: error.message }));
  } else if (message.type === 'cancel' && typeof message.id === 'number') {
    executions.get(message.id)?.abort();
  } else if (message.type === 'dispose') {
    Promise.resolve(plugin?.dispose?.()).then(() => { post({ type: 'disposed' }); process.exit(0); }).catch(() => process.exit(1));
  }
});
