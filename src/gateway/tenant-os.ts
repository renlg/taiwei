import { chmod, cp, lchown, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TenantAccountStore, type TenantAccountRepository } from './tenants.js';

const TENANT_OS_USER = /^guest[1-9]\d*$/;

async function withDefaultStore<T>(repository: TenantAccountRepository | undefined, run: (store: TenantAccountRepository) => Promise<T>): Promise<T> {
  if (repository) return run(repository);
  const store = new TenantAccountStore();
  try { return await run(store); }
  finally { store.close(); }
}

export async function osUserForGuest(username: string, repository?: TenantAccountRepository): Promise<string | undefined> {
  if (!username.trim()) return undefined;
  return withDefaultStore(repository, async (store) => {
    const account = await store.getByUsername(username.trim());
    return account?.status === 'active' && account.osProvisioned && TENANT_OS_USER.test(account.osUsername)
      ? account.osUsername
      : undefined;
  });
}

export async function giteaTokenFor(username: string, repository?: TenantAccountRepository): Promise<string | undefined> {
  if (!username.trim()) return undefined;
  return withDefaultStore(repository, async (store) => {
    const account = await store.getByUsername(username.trim());
    return account?.status === 'active' && account.giteaTokenProvisioned && account.giteaApiToken
      ? account.giteaApiToken
      : undefined;
  });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moveTree(source: string, target: string, warn: (message: string) => void): Promise<void> {
  if (!await pathExists(source)) return;
  if (!await pathExists(target)) {
    try { await rename(source, target); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await cp(source, target, { recursive: true, force: false, errorOnExist: true });
      await rm(source, { recursive: true, force: true });
      return;
    }
  }
  const [sourceInfo, targetInfo] = await Promise.all([lstat(source), lstat(target)]);
  if (!sourceInfo.isDirectory() || !targetInfo.isDirectory()) {
    warn(`[taiwei] guest workspace migration kept conflicting source path: ${source}`);
    return;
  }
  for (const entry of await readdir(source)) await moveTree(join(source, entry), join(target, entry), warn);
  await rmdir(source).catch(() => {});
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await chownTree(join(path, entry), uid, gid);
  }
  await lchown(path, uid, gid);
}

async function makeRootOwnedReadOnly(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await makeRootOwnedReadOnly(join(path, entry));
  }
  if (typeof process.getuid !== 'function' || process.getuid() === 0) await lchown(path, 0, 0);
  if (!info.isSymbolicLink()) await chmod(path, info.isDirectory() ? 0o555 : 0o444);
}

async function rebaseFolderFile(file: string | undefined, oldRoot: string, newRoot: string): Promise<void> {
  if (!file) return;
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Array.isArray(parsed)) return;
  let changed = false;
  const rebased = parsed.map((value) => {
    if (!value || typeof value !== 'object') return value;
    const folder = value as Record<string, unknown>;
    if (typeof folder.path !== 'string' || !isAbsolute(folder.path)) return value;
    const child = relative(resolve(oldRoot), resolve(folder.path));
    if (child.startsWith('..') || isAbsolute(child)) return value;
    changed = true;
    return { ...folder, path: resolve(newRoot, child) };
  });
  if (!changed) return;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(rebased, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export interface TenantWorkspaceOptions {
  homeRoot?: string;
  foldersFile?: string;
  warn?: (message: string) => void;
}

/** Resolve and prepare an OAuth guest workspace, returning the legacy path when no provisioned OS account exists. */
export async function tenantWorkspaceForGuest(
  username: string,
  legacyWorkspace: string,
  repository?: TenantAccountRepository,
  options: TenantWorkspaceOptions = {},
): Promise<string> {
  const warn = options.warn ?? console.warn;
  let osUsername: string | undefined;
  try { osUsername = await osUserForGuest(username, repository); }
  catch (error) {
    warn(`[taiwei] could not read OS account mapping for guest ${username}; using legacy workspace: ${error instanceof Error ? error.message : String(error)}`);
    return legacyWorkspace;
  }
  if (!osUsername) {
    warn(`[taiwei] no provisioned OS account found for guest ${username}; using legacy workspace`);
    return legacyWorkspace;
  }
  const home = join(options.homeRoot ?? '/home', osUsername);
  const projects = join(home, 'projects');
  let owner: Awaited<ReturnType<typeof stat>>;
  try {
    owner = await stat(home);
    await mkdir(projects, { recursive: true });
  } catch (error) {
    warn(`[taiwei] could not prepare workspace for ${osUsername}; using legacy workspace: ${error instanceof Error ? error.message : String(error)}`);
    await mkdir(legacyWorkspace, { recursive: true });
    return legacyWorkspace;
  }
  try { await moveTree(legacyWorkspace, projects, warn); }
  catch (error) { warn(`[taiwei] guest workspace migration for ${osUsername} was incomplete: ${error instanceof Error ? error.message : String(error)}`); }
  try { await rebaseFolderFile(options.foldersFile, legacyWorkspace, projects); }
  catch (error) { warn(`[taiwei] guest folder metadata migration for ${osUsername} failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    try { await chownTree(projects, owner.uid, owner.gid); }
    catch (error) { warn(`[taiwei] could not set workspace ownership for ${osUsername}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // Skills are managed by the service and exposed to the tenant as read-only scripts.
  const skillsSource = '/root/.taiwei/skills';
  const guestSkillsDir = join(home, '.taiwei', 'skills');
  try {
    await mkdir(guestSkillsDir, { recursive: true });
    for (const entry of await readdir(skillsSource)) {
      await cp(join(skillsSource, entry), join(guestSkillsDir, entry), { recursive: true, force: true });
    }
    await makeRootOwnedReadOnly(guestSkillsDir);
  } catch (error) {
    warn(`[taiwei] skill sync for ${osUsername} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return projects;
}
