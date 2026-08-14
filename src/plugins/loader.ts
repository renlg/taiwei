import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ToolRegistry } from '../tools/registry.js';
import type { Skill } from '../skills/loader.js';
import { parseSkill } from '../skills/loader.js';
import { ensureTaiweiHome } from '../util/paths.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { PolicyEngine } from '../security/policy.js';
import type { PolicyConfig } from '../security/policy.js';
import type { PluginManifest, PluginModule, PluginRuntimeApi, PluginToolHandler } from './api.js';

export interface PluginStatus { name: string; version?: string; enabled: boolean; tools: number; skills: number; crashed?: boolean; error?: string; }
interface LoadedPlugin { manifest: PluginManifest; module: PluginModule; pending: Set<Promise<unknown>>; toolNames: string[]; }
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
        const module = await this.importModule(main);
        const loaded: LoadedPlugin = { manifest, module, pending: new Set(), toolNames: [] };
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
    await loaded.module.dispose?.();
    for (const tool of loaded.toolNames) this.registry.unregister(tool);
    this.loaded.delete(name);
  }
  private async disposeAll(): Promise<void> { for (const name of [...this.loaded.keys()]) await this.dispose(name); }
}
