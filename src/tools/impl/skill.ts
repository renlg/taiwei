import type { SkillLoader } from '../../skills/loader.js';
import type { ToolSpec } from '../registry.js';

export function createLoadSkillTool(skillLoader: SkillLoader): ToolSpec {
  return {
    name: 'load_skill',
    description: 'Load an available skill\'s full instructions into the current conversation before using that skill.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name or skill directory name' } },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return 'Skill not found: ' + name;
      try {
        // includeDisabled lets us distinguish a disabled skill from one that does not exist.
        const skill = await skillLoader.load(name, { includeDisabled: true });
        if (skillLoader.isDisabled(skill)) return `Skill "${name}" is disabled`;
        if (!context.agentContext) return 'Unable to load skill: no active agent context';
        context.agentContext.activateSkill(skill);
        return skill.body;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}
