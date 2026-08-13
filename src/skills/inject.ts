import type { Skill } from './loader.js';

export function renderSkillIndex(skills: Skill[]): string {
  if (!skills.length) return '';
  return `Available skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}\n\nCall load_skill(name) to load a skill's full instructions before using it.`;
}

export function renderSkills(skills: Skill[]): string {
  if (!skills.length) return '';
  return `Active skills:\n${skills.map((skill) => `## ${skill.name}\n${skill.description}\n\n${skill.body}`).join('\n\n')}`;
}
