import { getAgentProfile, narrowProfile } from '../../agents/profiles.js';
import type { DelegationManager } from '../../agent/delegation.js';
import type { ToolSpec } from '../registry.js';

export function createDelegateTool(manager: DelegationManager): ToolSpec {
  return {
    name: 'delegate_task',
    description: 'Delegate an isolated task to a child agent; only its final result is returned.',
    parameters: {
      type: 'object', properties: { task: { type: 'string' }, agent: { type: 'string', enum: ['plan', 'build'] } },
      required: ['task'], additionalProperties: false,
    },
    async execute(args, context) {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) throw new Error('task must be a non-empty string');
      const parentProfile = context.agentProfile ?? getAgentProfile('build');
      const profile = narrowProfile(parentProfile, getAgentProfile(typeof args.agent === 'string' ? args.agent : parentProfile.id));
      return manager.delegate({ task, profile, parentProfile, parentSessionId: context.sessionId, depth: context.delegationDepth ?? 0, signal: context.signal });
    },
  };
}
