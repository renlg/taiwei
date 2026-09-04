import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';
import type { Skill } from '../skills/loader.js';
import { parseSkill } from '../skills/loader.js';
import { ensureTaiweiHome } from '../util/paths.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { PolicyEngine } from '../security/policy.js';
import type { PolicyConfig } from '../security/policy.js';
import type { PluginManifest, PluginModule, PluginRuntimeApi, PluginToolHandler } from './api.js';

export interface PluginStatus { name: string; version?: string; enabled: boolean; tools: number; skills: number; crashed?: boolean; error?: string; }
interface LoadedPlugin { manifest: PluginManifest; module?: PluginModule; worker?: Worker; pending: Set<Promise<unknown>>; toolNames: string[]; policyConfig: PolicyConfig; crashed?: boolean; crashError?: string; }
const EXECUTE_TIMEOUT_MS = 30_000;
const NAME = /^[a-z0-9-]{1,64}$/;
const requirePlugin = createRequire(import.meta.url);
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '_'); }

export function validateManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object') throw new Error('manifest must be an object');
  const manifest = value as Partial<PluginManifest>;
  if (!manifest.name || !NAME.test(manifest.name)) throw new Error('manifest name must match [a-z0-9-]{1,64}');
  if (manifest.apiVersion !== 1) throw new Error(`unsupported apiVersion ${String(manifest.apiVersion)} (expected 1)`);
  if (!manifest.version || typeof manifest.version !== 'string') throw new Error('manifest version is required');
  if (!manifest.main || typeof manifest.main !== 'string') throw new Error('manifest main is required');
  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.every((item) => typeof item === 'string')) throw new Error('manifest capabilities must be a string array');
  return manifest as PluginManifest;
}

export class PluginLoader {
  private statuses: PluginStatus[] = [];
  private injectedSkills: Skill[] = [];
  private loaded = new Map<string, LoadedPlugin>();
  constructor(private readonly registry: ToolRegistry) {}

  async reload(): Promise<void> {
    await this.disposeAll();
    const paths = await ensureTaiweiHome();
    this.registry.unregisterPrefix('plugin_'); this.statuses = []; this.injectedSkills = [];
    const config = await loadConfig();
    for (const entry of await readdir(paths.plugins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(paths.plugins, entry.name);
      let manifest: PluginManifest | undefined;
      try {
        manifest = await this.readManifest(directory);
        const setting = config.plugins?.[manifest.name];
        if (setting?.enabled === false) { this.statuses.push({ name: manifest.name, version: manifest.version, enabled: false, tools: 0, skills: 0 }); continue; }
        const main = resolve(directory, manifest.main);
        if (relative(directory, main).startsWith('..') || isAbsolute(relative(directory, main))) throw new Error('manifest main escapes plugin directory');
        await access(main);
        const useWorker = !manifest.capabilities.includes('main-process') && manifest.version !== '0.0.0-legacy';
        if (useWorker) {
          const loaded = await this.spawnWorker(main, manifest, directory, setting?.config ?? {}, config.policy);
          this.loaded.set(manifest.name, loaded);
          this.statuses.push({
            name: manifest.name, version: manifest.version, enabled: true, tools: loaded.toolNames.length,
            skills: this.injectedSkills.filter((skill) => skill.path.startsWith(directory)).length,
            ...(loaded.crashed ? { crashed: true, error: loaded.crashError } : {}),
          });
          continue;
        }
        const module = await this.importModule(main);
        const loaded: LoadedPlugin = { manifest, module, pending: new Set(), toolNames: [], policyConfig: config.policy };
        this.loaded.set(manifest.name, loaded);
        const runtime = this.runtime(loaded, directory, setting?.config ?? {}, config.policy);
        for (const skillPath of manifest.skills ?? []) await runtime.registerSkill(skillPath);
        const legacy = module as PluginModule & { tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; execute: PluginToolHandler }>; skills?: Array<Omit<Skill, 'path'>> };
        for (const tool of legacy.tools ?? []) runtime.registerTool(tool, tool.execute);
        for (const skill of legacy.skills ?? []) this.injectedSkills.push({ ...skill, path: main });
        await module.init?.(runtime);
        this.statuses.push({ name: manifest.name, version: manifest.version, enabled: true, tools: loaded.toolNames.length, skills: this.injectedSkills.filter((skill) => skill.path.startsWith(directory)).length });
      } catch (error) {
        const name = manifest?.name ?? entry.name;
        console.warn(`[taiwei] Plugin ${name} skipped: ${(error as Error).message}`);
        this.statuses.push({ name, version: manifest?.version, enabled: true, tools: 0, skills: 0, error: (error as Error).message });
      }
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!NAME.test(name)) throw new Error('Invalid plugin name');
    if (!enabled) await this.dispose(name);
    const config = await loadConfig();
    config.plugins = { ...config.plugins, [name]: { ...config.plugins?.[name], enabled } };
    await saveConfig(config);
    await this.reload();
  }

  list(): PluginStatus[] { return this.statuses.map((status) => ({ ...status })); }
  skills(): Skill[] { return [...this.injectedSkills]; }
  async close(): Promise<void> { await this.disposeAll(); }

  private async readManifest(directory: string): Promise<PluginManifest> {
    try { return validateManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { taiwei?: unknown };
        return validateManifest(pkg.taiwei);
      } catch (packageError) {
        if ((packageError as NodeJS.ErrnoException).code !== 'ENOENT') throw packageError;
        const name = directory.split('/').at(-1) ?? '';
        return validateManifest({ name, version: '0.0.0-legacy', apiVersion: 1, capabilities: ['legacy-full-trust'], main: 'plugin.js' });
      }
    }
  }

  private async importModule(file: string): Promise<PluginModule> {
    const source = await readFile(file, 'utf8');
    if (/\b(?:module\.exports|exports\.|require\s*\()/.test(source)) {
      const resolved = requirePlugin.resolve(file); delete requirePlugin.cache[resolved];
      const loaded = requirePlugin(resolved) as PluginModule | { default: PluginModule };
      return 'default' in loaded ? loaded.default : loaded;
    }
    const loaded = await import(`${pathToFileURL(file).href}?v=${Date.now()}`) as PluginModule & { default?: PluginModule };
    return loaded.default ?? loaded;
  }

  private async spawnWorker(file: string, manifest: PluginManifest, directory: string, pluginConfig: Record<string, unknown>, policyConfig: PolicyConfig): Promise<LoadedPlugin> {
    const workerUrl = new URL('./worker-script.js', import.meta.url);
    const worker = new Worker(workerUrl);
    const loaded: LoadedPlugin = { manifest, worker, pending: new Set(), toolNames: [], policyConfig };
    const prefix = `plugin_${safeName(manifest.name)}_`;
    type WorkerLoad = { tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>; skillPaths: string[]; skills: Array<Omit<Skill, 'path'>> };
    let workerLoad: WorkerLoad;
    try {
      workerLoad = await new Promise<WorkerLoad>((resolveLoad, rejectLoad) => {
        const cleanup = () => { clearTimeout(timer); worker.removeListener('message', onMessage); worker.removeListener('error', onError); worker.removeListener('exit', onExit); };
        const fail = (error: Error) => { cleanup(); rejectLoad(error); };
        const onMessage = (message: { type: string; tools?: WorkerLoad['tools']; skillPaths?: string[]; skills?: WorkerLoad['skills']; error?: string }) => {
          if (message.type === 'loaded') {
            // Install permanent crash handlers before removing the bootstrap handlers.
            worker.on('error', (error) => this.markWorkerCrashed(loaded, error.message));
            worker.on('exit', (code) => this.markWorkerCrashed(loaded, `worker exited (${code})`));
            cleanup();
            resolveLoad({ tools: message.tools ?? [], skillPaths: message.skillPaths ?? [], skills: message.skills ?? [] });
          }
          else if (message.type === 'error') fail(new Error(message.error ?? 'worker load failed'));
        };
        const onError = (error: Error) => fail(error);
        const onExit = (code: number) => fail(new Error(`Plugin "${manifest.name}" worker exited during load (${code})`));
        const timer = setTimeout(() => fail(new Error(`Plugin "${manifest.name}" worker load timed out`)), EXECUTE_TIMEOUT_MS);
        worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
        worker.postMessage({ type: 'load', file, config: pluginConfig, policyConfig, cwd: process.cwd(), skillPaths: manifest.skills ?? [] });
      });
    } catch (error) {
      await worker.terminate().catch(() => {});
      throw error;
    }
    try {
      for (const skillPath of workerLoad.skillPaths) {
        const full = resolve(directory, skillPath);
        if (relative(directory, full).startsWith('..') || isAbsolute(relative(directory, full))) throw new Error(`skill path escapes plugin directory: ${skillPath}`);
        this.injectedSkills.push(parseSkill(await readFile(full, 'utf8'), full));
      }
      for (const skill of workerLoad.skills) this.injectedSkills.push({ ...skill, path: file });
      // Forward worker log messages.
      worker.on('message', (message: { type: string; level?: string; message?: string }) => {
        if (message.type === 'log' && message.level && message.message) {
          const level = (['debug', 'info', 'warn', 'error'] as const).includes(message.level as 'debug') ? message.level as 'debug' | 'info' | 'warn' | 'error' : 'info';
          console[level](`[taiwei:plugin:${manifest.name}] ${message.message}`);
        }
      });
      for (const tool of workerLoad.tools) {
        const name = `${prefix}${safeName(tool.name)}`;
        loaded.toolNames.push(name);
        this.registry.register({
          name,
          description: tool.description,
          parameters: tool.parameters,
          execute: (args, context) => this.invokeWorker(loaded, name, tool.name, args, context),
        });
      }
      return loaded;
    } catch (error) {
      await worker.terminate().catch(() => {});
      throw error;
    }
  }

  private invokeWorker(loaded: LoadedPlugin, registeredTool: string, tool: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    const status = this.statuses.find((item) => item.name === loaded.manifest.name);
    if (loaded.crashed || status?.crashed) return Promise.resolve({ error: `Plugin "${loaded.manifest.name}" worker crashed and is unavailable` });
    const worker = loaded.worker;
    if (!worker) return Promise.resolve({ error: `Plugin "${loaded.manifest.name}" worker not available` });
    const policy = (context.policy ?? new PolicyEngine(loaded.policyConfig)).decide({
      role: context.role ?? 'admin', agentMode: context.agentProfile?.mode ?? 'build', sessionId: context.sessionId ?? 'local',
      tool: registeredTool, args, cwd: context.cwd, workspaceRoot: context.workspaceRoot ?? context.cwd, identity: context.identity ?? context.role ?? 'admin',
    });
    if (policy.effect === 'deny') return Promise.resolve({ error: `Tool "${registeredTool}" denied by policy`, policy: policy.rule });
    if (context.signal?.aborted) return Promise.resolve({ error: `Plugin "${loaded.manifest.name}" execution cancelled` });
    const pending = new Promise<unknown>((resolveExec) => {
      const id = Date.now() + Math.random();
      const cleanup = () => {
        clearTimeout(timer); worker.removeListener('message', onMessage); worker.removeListener('error', onError);
        worker.removeListener('exit', onExit); context.signal?.removeEventListener('abort', onAbort);
      };
      const settle = (value: unknown) => { cleanup(); resolveExec(value); };
      const timer = setTimeout(() => {
        cleanup(); worker.postMessage({ type: 'cancel', id }); void worker.terminate();
        this.markWorkerCrashed(loaded, 'worker execution timed out');
        resolveExec({ error: `Plugin "${loaded.manifest.name}" timed out after ${EXECUTE_TIMEOUT_MS}ms` });
      }, EXECUTE_TIMEOUT_MS);
      const onMessage = (message: { type: string; id?: number; ok?: boolean; result?: unknown; error?: string }) => {
        if (message.type === 'result' && message.id === id) {
          if (!message.ok && status) { status.crashed = true; status.error = message.error ?? 'worker execution failed'; }
          settle(message.ok ? message.result : { error: message.error ?? 'worker execution failed' });
        }
      };
      const onError = (error: Error) => {
        this.markWorkerCrashed(loaded, error.message);
        settle({ error: `Plugin "${loaded.manifest.name}" worker failed: ${error.message}` });
      };
      const onExit = (code: number) => {
        this.markWorkerCrashed(loaded, `worker exited (${code})`);
        settle({ error: `Plugin "${loaded.manifest.name}" worker exited (${code})` });
      };
      const onAbort = () => { worker.postMessage({ type: 'cancel', id }); settle({ error: `Plugin "${loaded.manifest.name}" execution cancelled` }); };
      worker.on('message', onMessage);
      worker.once('error', onError); worker.once('exit', onExit); context.signal?.addEventListener('abort', onAbort, { once: true });
      const serializableContext = {
        cwd: context.cwd, sessionId: context.sessionId, role: context.role, identity: context.identity, guestId: context.guestId,
        workspaceRoot: context.workspaceRoot, workspaceOnly: context.workspaceOnly, runId: context.runId,
        delegationDepth: context.delegationDepth, tenantIdentity: context.tenantIdentity, toolConfig: context.toolConfig,
        agentProfile: context.agentProfile ? structuredClone(context.agentProfile) : undefined,
        grantedModels: context.grantedModels ? [...context.grantedModels] : undefined,
        lsp: context.lsp ? structuredClone(context.lsp) : undefined,
      };
      worker.postMessage({ type: 'execute', id, tool, args, context: serializableContext });
    });
    loaded.pending.add(pending);
    return pending.finally(() => loaded.pending.delete(pending));
  }

  private markWorkerCrashed(loaded: LoadedPlugin, error: string): void {
    loaded.crashed = true;
    loaded.crashError = error;
    const status = this.statuses.find((item) => item.name === loaded.manifest.name);
    if (status) { status.crashed = true; status.error = error; }
  }

  private runtime(loaded: LoadedPlugin, directory: string, pluginConfig: Record<string, unknown>, policyConfig: PolicyConfig): PluginRuntimeApi {
    const prefix = `plugin_${safeName(loaded.manifest.name)}_`;
    return {
      log: (level, message) => console[level](`[taiwei:plugin:${loaded.manifest.name}] ${message}`),
      config: Object.freeze({ ...pluginConfig }),
      policyCheck: (tool, args) => new PolicyEngine(policyConfig).decide({ role: 'admin', agentMode: 'build', sessionId: `plugin:${loaded.manifest.name}`, tool, args, cwd: process.cwd(), workspaceRoot: process.cwd(), identity: loaded.manifest.name }),
      registerTool: (definition, handler) => {
        const name = `${prefix}${safeName(definition.name)}`;
        loaded.toolNames.push(name);
        this.registry.register({ ...definition, name, execute: (args, context) => this.invoke(loaded, handler, args, context) });
      },
      registerSkill: async (path) => {
        const full = resolve(directory, path);
        if (relative(directory, full).startsWith('..')) throw new Error(`skill path escapes plugin directory: ${path}`);
        this.injectedSkills.push(parseSkill(await readFile(full, 'utf8'), full));
      },
    };
  }

  private async invoke(loaded: LoadedPlugin, handler: PluginToolHandler, args: Record<string, unknown>, context: Parameters<PluginToolHandler>[1]): Promise<unknown> {
    const status = this.statuses.find((item) => item.name === loaded.manifest.name);
    if (status?.crashed) return { error: `Plugin "${loaded.manifest.name}" crashed and is unavailable` };
    const pending = Promise.resolve().then(() => handler(args, context)); loaded.pending.add(pending);
    try { return await pending; }
    catch (error) {
      if (status) { status.crashed = true; status.error = error instanceof Error ? error.message : String(error); }
      return { error: `Plugin "${loaded.manifest.name}" crashed: ${error instanceof Error ? error.message : String(error)}` };
    } finally { loaded.pending.delete(pending); }
  }

  private async dispose(name: string): Promise<void> {
    const loaded = this.loaded.get(name); if (!loaded) return;
    await Promise.allSettled([...loaded.pending]);
    if (loaded.worker) {
      loaded.worker.postMessage({ type: 'dispose' });
      await new Promise<void>((resolveDispose) => {
        const finish = () => { clearTimeout(timer); void loaded.worker?.terminate(); resolveDispose(); };
        const timer = setTimeout(finish, 3000);
        loaded.worker?.once('message', (message: { type: string }) => { if (message.type === 'disposed') finish(); });
        loaded.worker?.once('exit', finish);
      });
    }
    await loaded.module?.dispose?.();
    for (const tool of loaded.toolNames) this.registry.unregister(tool);
    this.loaded.delete(name);
  }
  private async disposeAll(): Promise<void> { for (const name of [...this.loaded.keys()]) await this.dispose(name); }
}
