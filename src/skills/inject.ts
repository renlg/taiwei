import type { Skill } from './loader.js';

export function renderSkills(skills: Skill[]): string {
  if (!skills.length) return '';
  return `Active skills:\n${skills.map((skill) => `## ${skill.name}\n${skill.description}\n\n${skill.body}`).join('\n\n')}`;
}
