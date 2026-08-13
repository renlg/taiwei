import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSpec, ToolRegistry } from '../tools/registry.js';
import type { Skill } from '../skills/loader.js';
import { ensureTaiweiHome } from '../util/paths.js';

export interface TaiweiPlugin {
  name: string;
  tools?: ToolSpec[];
  skills?: Array<Omit<Skill, 'path'>>;
  init?: (context: PluginContext) => Promise<void> | void;
}
export interface PluginContext { registry: ToolRegistry; home: string; }
export interface PluginStatus { name: string; tools: number; skills: number; error?: string; }

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '_'); }

export class PluginLoader {
  private statuses: PluginStatus[] = [];
  private injectedSkills: Skill[] = [];
  constructor(private readonly registry: ToolRegistry) {}

  async reload(): Promise<void> {
    const paths = await ensureTaiweiHome();
    this.registry.unregisterPrefix('plugin_'); this.statuses = []; this.injectedSkills = [];
    for (const entry of await readdir(paths.plugins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(paths.plugins, entry.name, 'plugin.js');
      try {
        let module: { default?: TaiweiPlugin } & Partial<TaiweiPlugin>;
        try {
          module = await import(`${pathToFileURL(file).href}?v=${Date.now()}`) as typeof module;
        } catch (firstError) {
          const source = await readFile(file, 'utf8');
          if (!/\b(?:export|import)\b/.test(source)) throw firstError;
          const encoded = Buffer.from(`${source}\n//# sourceURL=${pathToFileURL(file).href}`).toString('base64');
          module = await import(`data:text/javascript;base64,${encoded}`) as typeof module;
        }
        const plugin = (module.default ?? module) as TaiweiPlugin;
        if (!plugin.name) throw new Error('plugin must export a name');
        const prefix = `plugin_${safeName(plugin.name)}_`;
        for (const tool of plugin.tools ?? []) this.registry.register({ ...tool, name: `${prefix}${safeName(tool.name)}` });
        this.injectedSkills.push(...(plugin.skills ?? []).map((skill) => ({ ...skill, path: file })));
        await plugin.init?.({ registry: this.registry, home: paths.home });
        this.statuses.push({ name: plugin.name, tools: plugin.tools?.length ?? 0, skills: plugin.skills?.length ?? 0 });
      } catch (error) { this.statuses.push({ name: entry.name, tools: 0, skills: 0, error: (error as Error).message }); }
    }
  }

  list(): PluginStatus[] { return [...this.statuses]; }
  skills(): Skill[] { return [...this.injectedSkills]; }
}
