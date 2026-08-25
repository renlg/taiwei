import { getAgentProfile, narrowProfile } from '../../agents/profiles.js';
import type { DelegationManager } from '../../agent/delegation.js';
import type { ToolSpec, ToolConfigSchema } from '../registry.js';

const CONFIG: ToolConfigSchema = {
  allowedAgents: { type: 'string', default: 'research', label: '允许的子代理类型', description: '逗号分隔的 agent id 列表，未指定 agent 时默认 research' },
};

export function createDelegateTool(manager: DelegationManager): ToolSpec {
  return {
    name: 'delegate_task',
    description: 'Delegate an isolated task to a built-in or user-defined child agent; only its final result is returned. Defaults to the "research" agent. The selected name must be enabled via the allowedAgents tool setting.',
    configSchema: CONFIG,
    parameters: {
      type: 'object', properties: { task: { type: 'string' }, agent: { type: 'string', description: 'Built-in or user-defined agent name' }, agentId: { type: 'string', description: 'Alias for agent' } },
      required: ['task'], additionalProperties: false,
    },
    async execute(args, context) {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) throw new Error('task must be a non-empty string');
      if (!context.agentContext) throw new Error('delegate_task requires the caller agent context');
      const allowedRaw = typeof context.toolConfig?.allowedAgents === 'string' ? context.toolConfig.allowedAgents : 'research';
      const allowed = allowedRaw.split(',').map((value) => value.trim()).filter(Boolean);
      if (typeof args.agent === 'string' && typeof args.agentId === 'string' && args.agent !== args.agentId) throw new Error('agent and agentId must match when both are provided');
      const agentId = typeof args.agent === 'string' ? args.agent : typeof args.agentId === 'string' ? args.agentId : 'research';
      if (!allowed.includes(agentId)) throw new Error(`Delegating to agent "${agentId}" is not permitted; allowed agent types: ${allowed.join(', ')}`);
      const parentProfile = context.agentProfile ?? getAgentProfile('build');
      const profile = narrowProfile(parentProfile, getAgentProfile(agentId));
      const role = context.role ?? 'admin';
      return manager.delegate({
        task, profile, parentProfile, parentSessionId: context.sessionId,
        depth: context.delegationDepth ?? 0, signal: context.signal,
        role, identity: context.identity ?? role,
        workspaceRoot: context.workspaceRoot ?? context.cwd,
        memory: context.agentContext.memory,
        extendedMemory: context.agentContext.extendedMemory,
      });
    },
  };
}
