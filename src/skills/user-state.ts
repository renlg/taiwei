import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths, validateUserSkillOwner } from '../util/paths.js';
import { validateUserSkillName } from './user-store.js';

interface UserSkillStateFile { disabled: string[] }

export class UserSkillStateStore {
  constructor(private readonly root = getPaths().skillStates) {}

  private path(owner: string): string {
    return join(this.root, `${validateUserSkillOwner(owner)}.json`);
  }

  async disabled(owner: string): Promise<Set<string>> {
    const path = this.path(owner);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<UserSkillStateFile>;
      if (!Array.isArray(parsed.disabled)) return new Set();
      return new Set(parsed.disabled.flatMap((name) => {
        try { return typeof name === 'string' ? [validateUserSkillName(name)] : []; }
        catch { return []; }
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return new Set();
      throw error;
    }
  }

  async isEnabled(owner: string, name: string): Promise<boolean> {
    return !(await this.disabled(owner)).has(validateUserSkillName(name));
  }

  async setEnabled(owner: string, name: string, enabled: boolean): Promise<void> {
    const normalizedOwner = validateUserSkillOwner(owner);
    const normalizedName = validateUserSkillName(name);
    const disabled = await this.disabled(normalizedOwner);
    if (enabled) disabled.delete(normalizedName); else disabled.add(normalizedName);
    const path = this.path(normalizedOwner);
    const temporary = join(dirname(path), `.${normalizedOwner}.${randomUUID()}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  async remove(owner: string, name: string): Promise<void> {
    await this.setEnabled(owner, name, true);
  }
}
