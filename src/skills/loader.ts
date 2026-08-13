import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureTaiweiHome } from '../util/paths.js';

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

function parseFrontmatter(source: string, path: string): Skill {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`Skill ${path} is missing YAML frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field) fields.set(field[1], field[2].replace(/^(['"])(.*)\1$/, '$2').trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) throw new Error(`Skill ${path} requires name and description`);
  return { name, description, body: match[2].trim(), path };
}

export class SkillLoader {
  private disabled = new Set<string>();

  constructor(disabled: Iterable<string> = []) { this.setDisabled(disabled); }

  setDisabled(disabled: Iterable<string> = []): void {
    this.disabled = new Set([...disabled].map((name) => name.trim()).filter(Boolean));
  }

  isDisabled(skill: Skill | string): boolean {
    if (typeof skill === 'string') return this.disabled.has(skill);
    return this.disabled.has(skill.name) || this.disabled.has(skill.path.split('/').at(-2) ?? '');
  }

  async list(options: { includeDisabled?: boolean } = {}): Promise<Skill[]> {
    const { skills } = await ensureTaiweiHome();
    const entries = await readdir(skills, { withFileTypes: true });
    const loaded: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(skills, entry.name, 'SKILL.md');
      try {
        const skill = parseFrontmatter(await readFile(path, 'utf8'), path);
        if (options.includeDisabled || !this.isDisabled(skill)) loaded.push(skill);
      } catch { /* skip invalid skills in listings */ }
    }
    return loaded.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name: string, options: { includeDisabled?: boolean } = {}): Promise<Skill> {
    const skills = await this.list(options);
    const skill = skills.find((item) => item.name === name || item.path.split('/').at(-2) === name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    return skill;
  }
}
