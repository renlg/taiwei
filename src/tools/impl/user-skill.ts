import { guestIdForUsername } from '../../util/paths.js';
import { UserSkillStore } from '../../skills/user-store.js';
import { UserSkillStateStore } from '../../skills/user-state.js';
import type { ToolContext, ToolSpec } from '../registry.js';

function ownSkillOwner(context: ToolContext): string {
  return context.role === 'guest' ? context.guestId ?? guestIdForUsername(context.identity ?? 'guest') : 'admin';
}

function writableOwner(args: Record<string, unknown>, context: ToolContext): string {
  const own = ownSkillOwner(context);
  if (context.role === 'guest') return own;
  const requested = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : own;
  if (requested !== 'admin') throw new Error('create_skill and delete_skill can only manage the current admin owner');
  return own;
}

export function createUserSkillTools(store = new UserSkillStore(), states = new UserSkillStateStore()): ToolSpec[] {
  return [
    {
      name: 'create_skill',
      description: 'Create a reusable user-owned skill from complete SKILL.md content. Existing skills are never overwritten. Guests are always restricted to their own owner directory.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase skill directory/frontmatter name.' },
          content: { type: 'string', description: 'Complete SKILL.md with YAML frontmatter containing name and description, followed by workflow instructions.' },
          owner: { type: 'string', description: 'Optional owner. Guests cannot select another owner; admins create under admin.' },
        },
        required: ['name', 'content'],
      },
      async execute(args, context) {
        if (typeof args.name !== 'string' || typeof args.content !== 'string') throw new Error('name and content are required strings');
        return store.save(writableOwner(args, context), args.name, args.content);
      },
    },
    {
      name: 'list_skills',
      description: 'List user-created skills. Guests can only see their own skills; admins may list all owners or filter by owner.',
      parameters: {
        type: 'object',
        properties: { owner: { type: 'string', description: 'Optional owner filter (admin only).' } },
      },
      async execute(args, context) {
        if (context.role === 'guest') return { skills: await store.list(ownSkillOwner(context)) };
        const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined;
        return { skills: await store.list(owner) };
      },
    },
    {
      name: 'delete_skill',
      description: 'Permanently delete a user-created skill owned by the current user. Use only after the user has explicitly agreed to deletion; stopping or disabling a workflow is not consent to delete it. Guests cannot select another owner.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name to permanently delete.' },
          owner: { type: 'string', description: 'Optional owner. Guests cannot select another owner; admins delete under admin.' },
        },
        required: ['name'],
      },
      async execute(args, context) {
        if (typeof args.name !== 'string') throw new Error('name is required');
        const owner = writableOwner(args, context);
        const deleted = await store.delete(owner, args.name);
        if (deleted) await states.remove(owner, args.name);
        return { deleted };
      },
    },
  ];
}
