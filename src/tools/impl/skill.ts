import type { SkillLoader } from '../../skills/loader.js';
import { UserSkillStore } from '../../skills/user-store.js';
import { UserSkillStateStore } from '../../skills/user-state.js';
import { guestIdForUsername } from '../../util/paths.js';
import type { ToolSpec } from '../registry.js';

export function createLoadSkillTool(skillLoader: SkillLoader, userSkills = new UserSkillStore(), userSkillStates = new UserSkillStateStore()): ToolSpec {
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
        const owner = context.role === 'guest' ? context.guestId ?? guestIdForUsername(context.identity ?? 'guest') : 'admin';
        try {
          const userSkill = await userSkills.load(owner, name);
          if (!await userSkillStates.isEnabled(owner, userSkill.name)) return `Skill "${name}" is disabled for this user`;
          if (!context.agentContext) return 'Unable to load skill: no active agent context';
          context.agentContext.activateUserSkill(userSkill);
          return userSkill.body;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESKILLMISMATCH') {
            throw new Error(`User skill "${name}" exists but its frontmatter is invalid (${(error as Error).message}). Fix or delete it before loading a system skill with the same name.`);
          }
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // ENOENT means the user skill does not exist; fall through to the system skill loader.
        }
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
