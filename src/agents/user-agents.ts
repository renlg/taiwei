import { readFileSync } from 'node:fs';
import { getPaths } from '../util/paths.js';
import type { AgentProfile } from './profiles.js';

interface UserAgentDefinition {
  name?: unknown;
  mode?: unknown;
  systemPrompt?: unknown;
  model?: unknown;
  tools?: unknown;
  maxTurns?: unknown;
}

const BUILTIN_AGENT_IDS = new Set(['plan', 'build', 'research']);
const KNOWN_TOOL_NAMES = new Set([
  'bash', 'create_skill', 'delegate_task', 'delete_skill', 'edit_file', 'generate_image', 'generate_video',
  'get_diagnostics', 'list_skills', 'load_skill', 'memory_append', 'memory_extend', 'memory_list', 'memory_read',
  'nginx_add_proxy', 'rag_search', 'read_file', 'search_files', 'session_get', 'session_list', 'session_search',
  'task_kill', 'task_poll', 'task_start', 'task_wait', 'watchdog_list', 'watchdog_register', 'watchdog_remove',
  'watchdog_status', 'web_search', 'write_file',
]);

let cache: { path: string; profiles: readonly AgentProfile[] } | undefined;

function fail(path: string, error: unknown): readonly AgentProfile[] {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[taiwei] Failed to load user agents from ${path}: ${detail}. Falling back to built-in agents only.`);
  return [];
}

function requiredString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`agents[${index}].${field} must be a non-empty string`);
  return value.trim();
}

function parseAgent(value: unknown, index: number, names: Set<string>): AgentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`agents[${index}] must be an object`);
  const definition = value as UserAgentDefinition;
  const id = requiredString(definition.name, 'name', index);
  if (names.has(id)) throw new Error(`agent name "${id}" conflicts with a built-in or another user agent`);
  names.add(id);
  if (definition.mode !== 'plan' && definition.mode !== 'build') throw new Error(`agents[${index}].mode must be "plan" or "build"`);
  const prompt = requiredString(definition.systemPrompt, 'systemPrompt', index);
  if (definition.model !== undefined && (typeof definition.model !== 'string' || !definition.model.trim())) {
    throw new Error(`agents[${index}].model must be a non-empty string when provided`);
  }
  if (definition.maxTurns !== undefined && (!Number.isInteger(definition.maxTurns) || (definition.maxTurns as number) <= 0)) {
    throw new Error(`agents[${index}].maxTurns must be a positive integer when provided`);
  }
  let tools: string[] | undefined;
  if (definition.tools !== undefined) {
    if (!Array.isArray(definition.tools) || definition.tools.length === 0 || definition.tools.some((tool) => typeof tool !== 'string' || !tool.trim())) {
      throw new Error(`agents[${index}].tools must be a non-empty array of tool names when provided`);
    }
    tools = [...new Set(definition.tools.map((tool) => (tool as string).trim()))];
    for (const tool of tools) {
      if (!tool.includes('*') && !KNOWN_TOOL_NAMES.has(tool)) {
        console.warn(`[taiwei] User agent "${id}" references unknown tool "${tool}"; keeping it for dynamically registered tools.`);
      }
    }
  }
  return {
    id,
    mode: definition.mode,
    prompt,
    ...(typeof definition.model === 'string' ? { model: definition.model.trim() } : {}),
    ...(typeof definition.maxTurns === 'number' ? { maxTurns: definition.maxTurns } : {}),
    ...(tools ? { toolPolicy: { allow: tools } } : {}),
  };
}

/** Load once per TAIWEI_HOME. Explicit reload is available, but normal changes take effect after restart. */
export function loadUserAgents(reload = false): readonly AgentProfile[] {
  const path = getPaths().agentsFile;
  if (!reload && cache?.path === path) return cache.profiles;
  let profiles: readonly AgentProfile[];
  try {
    let text: string;
    try { text = readFileSync(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') profiles = [];
      else throw error;
      cache = { path, profiles };
      return profiles;
    }
    const parsed = JSON.parse(text) as { agents?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) throw new Error('root must be an object with an agents array');
    const names = new Set(BUILTIN_AGENT_IDS);
    profiles = parsed.agents.map((agent, index) => parseAgent(agent, index, names));
  } catch (error) {
    profiles = fail(path, error);
  }
  cache = { path, profiles };
  return profiles;
}

export function reloadUserAgents(): readonly AgentProfile[] { return loadUserAgents(true); }
