import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type FolderOwner = 'admin' | 'guest';

export interface GatewayFolder {
  id: string;
  name: string;
  path: string;
  dirName: string;
  parentId?: string;
  system: boolean;
  owner: FolderOwner;
  default: boolean;
}

export interface FolderStoreOptions {
  file: string;
  owner: FolderOwner;
  rootPath: string;
  defaultId: string;
  defaultName: string;
  defaultDirName: string;
  defaultPath: () => string | Promise<string>;
}

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_DIR_NAME = /^[a-zA-Z0-9_-]+$/;

export function guestFolderName(username: string): string {
  return createHash('md5').update(username).digest('hex');
}

function normalizedName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Folder name must be a string');
  const name = value.trim();
  if (!name) throw new Error('Folder name cannot be empty');
  if (Array.from(name).length > 64) throw new Error('Folder name must be at most 64 characters');
  return name;
}

export function folderDirName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return safe || 'workspace';
}

export function workspaceFolderMetadata(workspacePath: string): { name: string; dirName: string } {
  const name = basename(resolve(workspacePath)) || 'workspace';
  return { name, dirName: folderDirName(name) };
}

export class FolderStore {
  constructor(private readonly options: FolderStoreOptions) {
    if (!VALID_ID.test(options.defaultId) || !VALID_DIR_NAME.test(options.defaultDirName)) throw new Error('Invalid default folder metadata');
  }

  async list(): Promise<GatewayFolder[]> {
    const folders = await this.ensureDefault();
    return this.resolveDefaults(folders);
  }

  async defaultFolder(): Promise<GatewayFolder> {
    const folders = await this.list();
    return folders.find((folder) => folder.default)!;
  }

  async get(id: string): Promise<GatewayFolder | undefined> {
    if (!VALID_ID.test(id)) return undefined;
    return (await this.list()).find((folder) => folder.id === id);
  }

  async create(nameValue: unknown, parentId?: string): Promise<GatewayFolder> {
    const name = normalizedName(nameValue);
    const folders = await this.list();
    const parent = parentId ? folders.find((folder) => folder.id === parentId) : undefined;
    if (parentId && !parent) throw new Error('Parent folder not found');
    this.assertUniqueName(folders, name, parentId);
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const baseDirName = folderDirName(name);
    let dirName = baseDirName;
    let suffix = 2;
    const siblings = folders.filter((folder) => folder.parentId === parentId);
    while (siblings.some((folder) => folder.dirName.toLowerCase() === dirName.toLowerCase())) dirName = `${baseDirName.slice(0, 32)}-${suffix++}`;
    const path = resolve(parent ? parent.path : this.options.rootPath, dirName);
    await mkdir(path, { recursive: true });
    const folder: GatewayFolder = { id, name, path, dirName, ...(parentId ? { parentId } : {}), system: false, owner: this.options.owner, default: false };
    folders.push(folder);
    await this.save(folders);
    return folder;
  }

  async rename(id: string, nameValue: unknown): Promise<GatewayFolder | undefined> {
    const name = normalizedName(nameValue);
    const folders = await this.list();
    const folder = folders.find((item) => item.id === id);
    if (!folder) return undefined;
    if (folder.system) throw new Error('System folders cannot be renamed');
    this.assertUniqueName(folders, name, folder.parentId, folder.id);
    folder.name = name;
    await this.save(folders);
    return folder;
  }

  async delete(id: string): Promise<boolean> {
    const folders = await this.list();
    const folder = folders.find((item) => item.id === id);
    if (!folder) return false;
    if (folder.system) throw new Error('System folders cannot be deleted');
    if (folders.some((item) => item.parentId === id)) throw new Error('Folder contains sub-folders');
    await this.save(folders.filter((item) => item.id !== id));
    return true;
  }

  private async ensureDefault(): Promise<GatewayFolder[]> {
    const folders = await this.read();
    if (!folders.some((folder) => folder.id === this.options.defaultId)) {
      const path = resolve(await this.options.defaultPath());
      await mkdir(path, { recursive: true });
      folders.unshift({
        id: this.options.defaultId,
        name: this.options.defaultName,
        path,
        dirName: this.options.defaultDirName,
        system: true,
        owner: this.options.owner,
        default: true,
      });
      await this.save(folders);
    }
    return folders;
  }

  private async resolveDefaults(folders: GatewayFolder[]): Promise<GatewayFolder[]> {
    const defaultPath = resolve(await this.options.defaultPath());
    const resolvedFolders = folders.map((folder) => folder.id === this.options.defaultId
      ? { ...folder, name: this.options.defaultName, path: defaultPath, dirName: this.options.defaultDirName, system: true, owner: this.options.owner, default: true }
      : { ...folder, default: false, owner: this.options.owner });
    await Promise.all(resolvedFolders.map((folder) => mkdir(folder.path, { recursive: true })));
    // Persist reconciliation so legacy defaults are migrated on the first load
    // instead of only appearing renamed in memory.
    if (JSON.stringify(resolvedFolders) !== JSON.stringify(folders)) await this.save(resolvedFolders);
    return resolvedFolders;
  }

  private assertUniqueName(folders: GatewayFolder[], name: string, parentId?: string, exceptId?: string): void {
    const key = name.toLocaleLowerCase();
    if (folders.some((folder) => folder.id !== exceptId && folder.parentId === parentId && folder.name.toLocaleLowerCase() === key)) {
      throw new Error('A folder with this name already exists here');
    }
  }

  private async read(): Promise<GatewayFolder[]> {
    try {
      const value = JSON.parse(await readFile(this.options.file, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('Folder file must contain an array');
      return value.filter((item): item is GatewayFolder => {
        if (!item || typeof item !== 'object') return false;
        const folder = item as Partial<GatewayFolder>;
        return typeof folder.id === 'string' && VALID_ID.test(folder.id)
          && typeof folder.name === 'string' && typeof folder.path === 'string' && isAbsolute(folder.path)
          && typeof folder.dirName === 'string' && VALID_DIR_NAME.test(folder.dirName)
          && typeof folder.system === 'boolean';
      }).map((folder) => ({ ...folder, owner: this.options.owner, default: folder.id === this.options.defaultId }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Invalid folder file at ${this.options.file}: ${(error as Error).message}`);
    }
  }

  private async save(folders: GatewayFolder[]): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true });
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(folders, null, 2)}\n`, 'utf8');
    await rename(temporary, this.options.file);
  }
}
