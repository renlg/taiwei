import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths, validateUserSkillOwner } from '../util/paths.js';
import { parseSkill, type Skill } from './loader.js';

const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface UserSkill {
  name: string;
  description: string;
  owner: string;
  path: string;
}

export interface SavedUserSkill extends UserSkill {
  created: boolean;
}

export function validateUserSkillName(name: string): string {
  const normalized = name.trim();
  if (!VALID_SKILL_NAME.test(normalized)) throw new Error('Invalid skill name; use 1-64 lowercase letters, numbers, hyphens, or underscores');
  return normalized;
}

export class UserSkillStore {
  constructor(private readonly root = getPaths().userSkills) {}

  private ownerDirectory(owner: string): string {
    return join(this.root, validateUserSkillOwner(owner));
  }

  private skillPath(owner: string, name: string): string {
    return join(this.ownerDirectory(owner), validateUserSkillName(name), 'SKILL.md');
  }

  async save(owner: string, name: string, content: string): Promise<SavedUserSkill> {
    const normalizedName = validateUserSkillName(name);
    const path = this.skillPath(owner, normalizedName);
    const parsed = parseSkill(content, path);
    if (parsed.name !== normalizedName) throw new Error(`Skill frontmatter name must equal "${normalizedName}"`);
    await mkdir(join(this.ownerDirectory(owner), normalizedName), { recursive: true });
    try {
      await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf8', flag: 'wx' });
      return { name: parsed.name, description: parsed.description, owner, path, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = parseSkill(await readFile(path, 'utf8'), path);
      return { name: existing.name, description: existing.description, owner, path, created: false };
    }
  }

  async read(owner: string, name: string): Promise<string> {
    return readFile(this.skillPath(owner, name), 'utf8');
  }

  async load(owner: string, name: string): Promise<Skill> {
    const path = this.skillPath(owner, name);
    const skill = parseSkill(await readFile(path, 'utf8'), path);
    if (skill.name !== validateUserSkillName(name)) {
      const error = new Error(`Skill frontmatter name must equal "${name}"`) as NodeJS.ErrnoException;
      error.code = 'ESKILLMISMATCH';
      throw error;
    }
    return skill;
  }

  async loadEnabled(owner: string, disabled: ReadonlySet<string> = new Set()): Promise<Skill[]> {
    const skills = await this.list(owner);
    const loaded: Skill[] = [];
    for (const skill of skills) {
      if (disabled.has(skill.name)) continue;
      try { loaded.push(await this.load(owner, skill.name)); }
      catch { /* Invalid or concurrently deleted skills are omitted. */ }
    }
    return loaded;
  }

  async list(owner?: string): Promise<UserSkill[]> {
    let owners: string[];
    if (owner) owners = [validateUserSkillOwner(owner)];
    else {
      try {
        owners = (await readdir(this.root, { withFileTypes: true })).flatMap((entry) => {
          if (!entry.isDirectory()) return [];
          try { return [validateUserSkillOwner(entry.name)]; } catch { return []; }
        });
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }
    const skills: UserSkill[] = [];
    for (const skillOwner of owners) {
      let entries;
      try { entries = await readdir(this.ownerDirectory(skillOwner), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const path = this.skillPath(skillOwner, entry.name);
          const parsed = parseSkill(await readFile(path, 'utf8'), path);
          if (parsed.name !== entry.name || !VALID_SKILL_NAME.test(parsed.name)) continue;
          skills.push({ name: parsed.name, description: parsed.description, owner: skillOwner, path });
        } catch { /* Invalid user skills are omitted from listings. */ }
      }
    }
    return skills.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
  }

  async delete(owner: string, name: string): Promise<boolean> {
    const directory = join(this.ownerDirectory(owner), validateUserSkillName(name));
    try { await rm(directory, { recursive: true }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
}
