import { getAgentProfile, narrowProfile } from '../../agents/profiles.js';
import type { DelegationManager } from '../../agent/delegation.js';
import type { ToolSpec, ToolConfigSchema } from '../registry.js';

const CONFIG: ToolConfigSchema = {
  allowedAgents: { type: 'string', default: 'research', label: '允许的子代理类型', description: '逗号分隔的 agent id 列表，未指定 agent 时默认 research' },
};

export function createDelegateTool(manager: DelegationManager): ToolSpec {
  return {
    name: 'delegate_task',
    description: 'Delegate an isolated task to a child agent; only its final result is returned. Defaults to the "research" agent (read-only: search files, read files, web search). Administrators may enable "plan" or "build" via the allowedAgents tool setting.',
    configSchema: CONFIG,
    parameters: {
      type: 'object', properties: { task: { type: 'string' }, agent: { type: 'string', enum: ['research', 'plan', 'build'] } },
      required: ['task'], additionalProperties: false,
    },
    async execute(args, context) {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) throw new Error('task must be a non-empty string');
      if (!context.agentContext) throw new Error('delegate_task requires the caller agent context');
      const allowedRaw = typeof context.toolConfig?.allowedAgents === 'string' ? context.toolConfig.allowedAgents : 'research';
      const allowed = allowedRaw.split(',').map((value) => value.trim()).filter(Boolean);
      const agentId = typeof args.agent === 'string' ? args.agent : 'research';
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
