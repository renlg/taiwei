export interface AgentProfile {
  id: string;
  mode: 'plan' | 'build';
  prompt: string;
  model?: string;
  maxTurns?: number;
  toolPolicy?: { deny: string[] };
}

export const BUILTIN_AGENTS: readonly AgentProfile[] = [
  {
    id: 'plan', mode: 'plan',
    prompt: 'Plan mode: investigate, reason, and propose a precise plan. You are read-only and must not modify files or execute shell commands.',
    toolPolicy: { deny: ['bash', 'write_file', 'edit_file', 'apply_patch', 'memory_append', 'memory_extend', 'plugin_*'] },
  },
  { id: 'build', mode: 'build', prompt: 'Build mode: implement and verify requested changes using the available tools.' },
];

export function getAgentProfile(id = 'build'): AgentProfile {
  const profile = BUILTIN_AGENTS.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown agent profile: ${id}`);
  return { ...profile, toolPolicy: profile.toolPolicy ? { deny: [...profile.toolPolicy.deny] } : undefined };
}

export function toolDenied(name: string, profile?: AgentProfile): boolean {
  return profile?.toolPolicy?.deny.some((pattern) => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern) ?? false;
}

export function narrowProfile(parent: AgentProfile, child: AgentProfile): AgentProfile {
  if (parent.mode === 'plan' && child.mode === 'build') throw new Error('A plan agent cannot delegate to a build agent');
  return { ...child, toolPolicy: { deny: [...new Set([...(parent.toolPolicy?.deny ?? []), ...(child.toolPolicy?.deny ?? [])])] } };
}
