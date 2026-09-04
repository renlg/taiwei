import { loadUserAgents } from './user-agents.js';

export interface AgentProfile {
  id: string;
  mode: 'plan' | 'build';
  prompt: string;
  model?: string;
  maxTurns?: number;
  toolPolicy?: { allow?: string[]; deny?: string[] };
}

export const BUILTIN_AGENTS: readonly AgentProfile[] = [
  {
    id: 'plan', mode: 'plan',
    prompt: 'Plan mode: investigate, reason, and propose a precise plan. You are read-only and must not modify files or execute shell commands.',
    toolPolicy: { deny: ['bash', 'write_file', 'edit_file', 'apply_patch', 'memory_append', 'memory_extend', 'plugin_*', 'browser_*', 'mcp_*', 'lsp_*'] },
  },
  { id: 'build', mode: 'build', prompt: 'Build mode: implement and verify requested changes using the available tools.' },
  {
    id: 'research', mode: 'plan',
    prompt: 'Research mode: you may only search code, read files, navigate symbols, and search the public web to investigate and report findings. You cannot modify files, run shell commands, manage memory, browse interactively, or call MCP/plugin tools.',
    toolPolicy: { allow: ['search_files', 'read_file', 'web_search', 'document_symbols', 'go_to_definition', 'find_references', 'todo_write', 'todo_read'] },
  },
];

export function getAgentProfile(id = 'build'): AgentProfile {
  const profile = BUILTIN_AGENTS.find((item) => item.id === id) ?? loadUserAgents().find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown agent profile: ${id}`);
  return cloneProfile(profile);
}

export function getAgentProfiles(): AgentProfile[] {
  return [...BUILTIN_AGENTS, ...loadUserAgents()].map(cloneProfile);
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    toolPolicy: profile.toolPolicy ? {
      ...(profile.toolPolicy.allow ? { allow: [...profile.toolPolicy.allow] } : {}),
      ...(profile.toolPolicy.deny ? { deny: [...profile.toolPolicy.deny] } : {}),
    } : undefined,
  };
}

export function matchesToolPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export function toolDenied(name: string, profile?: AgentProfile): boolean {
  const policy = profile?.toolPolicy;
  if (!policy) return false;
  if (policy.allow && policy.allow.length > 0) {
    return !policy.allow.some((pattern) => matchesToolPattern(name, pattern));
  }
  return policy.deny?.some((pattern) => matchesToolPattern(name, pattern)) ?? false;
}

function intersectAllow(parent?: string[], child?: string[]): string[] | undefined {
  if (!parent || !child) return undefined;
  const result: string[] = [];
  for (const parentPattern of parent) {
    for (const childPattern of child) {
      let intersection: string | undefined;
      const parentWildcard = parentPattern.endsWith('*');
      const childWildcard = childPattern.endsWith('*');
      if (!parentWildcard && !childWildcard) intersection = parentPattern === childPattern ? parentPattern : undefined;
      else if (!parentWildcard) intersection = matchesToolPattern(parentPattern, childPattern) ? parentPattern : undefined;
      else if (!childWildcard) intersection = matchesToolPattern(childPattern, parentPattern) ? childPattern : undefined;
      else {
        const parentPrefix = parentPattern.slice(0, -1);
        const childPrefix = childPattern.slice(0, -1);
        if (parentPrefix.startsWith(childPrefix)) intersection = parentPattern;
        else if (childPrefix.startsWith(parentPrefix)) intersection = childPattern;
      }
      if (intersection && !result.includes(intersection)) result.push(intersection);
    }
  }
  return result.length > 0 ? result : undefined;
}

export function narrowProfile(parent: AgentProfile, child: AgentProfile): AgentProfile {
  if (parent.mode === 'plan' && child.mode === 'build') throw new Error('A plan agent cannot delegate to a build agent');
  const parentAllow = parent.toolPolicy?.allow;
  const childAllow = child.toolPolicy?.allow;
  if (parentAllow && parentAllow.length > 0 && childAllow && childAllow.length > 0) {
    const intersection = intersectAllow(parentAllow, childAllow);
    if (!intersection) throw new Error(`Agent "${child.id}" has no tools in common with the parent allow list`);
    const mergedDeny = [...new Set([...(parent.toolPolicy?.deny ?? []), ...(child.toolPolicy?.deny ?? [])])];
    return { ...child, toolPolicy: { allow: intersection, ...(mergedDeny.length > 0 ? { deny: mergedDeny } : {}) } };
  }
  const allow = parentAllow?.slice() ?? childAllow?.slice();
  const deny = [...new Set([...(parent.toolPolicy?.deny ?? []), ...(child.toolPolicy?.deny ?? [])])];
  return { ...child, toolPolicy: { ...(allow ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) } };
}
