import { readFile } from 'node:fs/promises';
import { validateUserSkillName } from '../../skills/user-store.js';
import { validateUserSkillOwner } from '../../util/paths.js';
import type { Skill } from '../../skills/loader.js';
import { HttpError, json, readJson } from '../http.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/skills* and /api/user-skills*. */
export async function handleSkillRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname, scope } = ctx;
  const { skillLoader, userSkillStore, userSkillStateStore, allSkills, configState } = runtime;
  const { auth } = scope;
  const guestId = auth.guestId;

  if (method === 'GET' && pathname === '/api/skills') {
    const config = await configState.load();
    const skills = await allSkills(config);
    // 角色感知：admin 管系统技能，guest 浏览系统技能+个人已安装技能
    const skillStoreOwner = auth.role === 'guest' ? guestId : undefined;
    if (auth.role === 'guest' && !skillStoreOwner) throw new HttpError(403, 'Guest skill owner is unavailable');
    const installedSkills = skillStoreOwner ? await userSkillStore.list(skillStoreOwner) : [];
    const installed = new Set(installedSkills.map((skill) => skill.name));
    const disabled = skillStoreOwner ? await userSkillStateStore.disabled(skillStoreOwner) : new Set<string>();
    const configDisabled = new Set(config.skillsDisabled ?? []);
    json(response, 200, { skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: skillStoreOwner
        ? installed.has(skill.name) && !disabled.has(skill.name)
        : !(skillLoader.isDisabled?.(skill) ?? configDisabled.has(skill.name)),
      installed: installed.has(skill.name),
      source: 'system',
    })) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/skills/install') {
    const skillStoreOwner = auth.role === 'guest' ? guestId : undefined;
    if (!skillStoreOwner) throw new HttpError(403, 'Only guests can install skills to their personal directory');
    const body = await readJson(request) as { name?: unknown };
    if (typeof body.name !== 'string') throw new HttpError(400, 'name is required');
    let name: string;
    try { name = validateUserSkillName(body.name); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
    let skill: Skill;
    try { skill = await skillLoader.load(name, { includeDisabled: true }); }
    catch { throw new HttpError(404, `Skill not found: ${name}`); }
    const saved = await userSkillStore.save(skillStoreOwner, name, await readFile(skill.path, 'utf8'));
    json(response, 200, { ok: true, installed: true, created: saved.created });
    return true;
  }
  if (method === 'GET' && pathname === '/api/user-skills') {
    const owner = auth.role === 'guest' ? guestId : 'admin';
    if (!owner) throw new HttpError(403, 'Guest skill owner is unavailable');
    const skills = await userSkillStore.list(owner);
    const disabled = await userSkillStateStore.disabled(owner);
    json(response, 200, { skills: skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        owner: skill.owner,
        enabled: !disabled.has(skill.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)) });
    return true;
  }
  const userSkillRoute = pathname.match(/^\/api\/user-skills\/([^/]+)\/([^/]+)$/);
  if (userSkillRoute && (method === 'POST' || method === 'DELETE')) {
    const myOwner = auth.role === 'guest' ? guestId : 'admin';
    if (!myOwner) throw new HttpError(403, 'Guest skill owner is unavailable');
    let owner: string;
    let name: string;
    try {
      owner = validateUserSkillOwner(decodeURIComponent(userSkillRoute[1]));
      name = validateUserSkillName(decodeURIComponent(userSkillRoute[2]));
    } catch (error) {
      throw new HttpError(400, error instanceof URIError ? '蒸馏技能路径编码无效' : (error as Error).message);
    }
    if (owner !== myOwner) throw new HttpError(403, '无权操作其他用户的蒸馏技能');
    if (method === 'DELETE') {
      const deleted = await userSkillStore.delete(owner, name);
      if (!deleted) throw new HttpError(404, '蒸馏技能不存在');
      await userSkillStateStore.remove(owner, name);
      json(response, 200, { ok: true, deleted: true });
      return true;
    }
    const body = await readJson(request) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
    try { await userSkillStore.read(owner, name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, '蒸馏技能不存在');
      throw error;
    }
    await userSkillStateStore.setEnabled(owner, name, body.enabled);
    json(response, 200, { ok: true, enabled: body.enabled });
    return true;
  }
  const skillRoute = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillRoute && (method === 'GET' || method === 'POST' || method === 'DELETE')) {
    let name: string;
    try { name = decodeURIComponent(skillRoute[1]); }
    catch { throw new HttpError(400, '技能名称编码无效'); }
    const config = await configState.load();
    const skills = await allSkills(config);
    const skill = skills.find((item) => item.name === name || item.path.split('/').at(-2) === name);
    if (method === 'GET') {
      if (!skill) throw new HttpError(404, `技能不存在：${name}`);
      json(response, 200, { name: skill.name, description: skill.description, content: await readFile(skill.path, 'utf8') });
      return true;
    }
    if (method === 'DELETE') {
      // guest 删除自己安装的个人技能副本；admin 无个人副本概念
      if (auth.role !== 'guest') throw new HttpError(403, 'Only guests can delete installed skills');
      const skillStoreOwner = guestId;
      if (!skillStoreOwner) throw new HttpError(403, 'Guest skill owner is unavailable');
      const deleted = await userSkillStore.delete(skillStoreOwner, name);
      if (!deleted) throw new HttpError(404, 'Installed skill not found');
      await userSkillStateStore.remove(skillStoreOwner, name);
      json(response, 200, { ok: true, deleted: true });
      return true;
    }
    // POST：admin 启停系统技能；guest 启停自己安装的个人技能副本
    const body = await readJson(request) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
    if (auth.role === 'guest') {
      const skillStoreOwner = guestId;
      if (!skillStoreOwner) throw new HttpError(403, 'Guest skill owner is unavailable');
      try { await userSkillStore.load(skillStoreOwner, name); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Installed skill not found');
        throw error;
      }
      await userSkillStateStore.setEnabled(skillStoreOwner, name, body.enabled);
      json(response, 200, { ok: true, enabled: body.enabled });
      return true;
    }
    if (!skill) throw new HttpError(404, `技能不存在：${name}`);
    const aliases = new Set([name, skill.name, skill.path.split('/').at(-2) ?? '']);
    const disabled = new Set(config.skillsDisabled ?? []);
    if (body.enabled) for (const alias of aliases) disabled.delete(alias);
    else disabled.add(skill.name);
    config.skillsDisabled = [...disabled].sort();
    await configState.save(config);
    skillLoader.setDisabled?.(config.skillsDisabled);
    json(response, 200, { ok: true, enabled: body.enabled });
    return true;
  }
  return false;
}
