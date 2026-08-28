import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentContext } from '../src/agent/context.js';
import type { TaiweiApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { AgentChatBridge, type ChatSink } from '../src/gateway/chat.js';
import { closeGateway, createGatewayServer, guestIdForUsername, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { MemoryStore } from '../src/memory/store.js';
import type { Skill } from '../src/skills/loader.js';
import { UserSkillStateStore } from '../src/skills/user-state.js';
import { UserSkillStore } from '../src/skills/user-store.js';
import { installGatewayTestAdminAuth } from './gateway-test-auth.js';

installGatewayTestAdminAuth();

const source = (name: string, description: string, body = `${name.toUpperCase()}_BODY`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

async function catalog(directory: string): Promise<Skill[]> {
  const definitions = [
    ['alpha', 'Alpha workflow'],
    ['beta', 'Find a Needle in this description'],
    ['gamma', 'Gamma workflow'],
  ] as const;
  const skills: Skill[] = [];
  for (const [name, description] of definitions) {
    const path = join(directory, 'system-skills', name, 'SKILL.md');
    await mkdir(join(directory, 'system-skills', name), { recursive: true });
    await writeFile(path, source(name, description), 'utf8');
    skills.push({ name, description, body: `${name.toUpperCase()}_BODY`, path });
  }
  return skills;
}

test('merged skill API: role-aware list with installed flag, install, toggle, and delete for guests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-skill-store-'));
  const skills = await catalog(directory);
  const userSkills = new UserSkillStore(join(directory, 'user-skills'));
  const states = new UserSkillStateStore(join(directory, 'skill-states'));
  const authSessions = new AuthSessionStore(join(directory, 'auth.json'));
  const guestToken = await authSessions.create('Alice.Example', 'guest');
  const guestOwner = guestIdForUsername('Alice.Example');
  const loader = {
    list: async () => skills,
    load: async (name: string) => {
      const skill = skills.find((item) => item.name === name);
      if (!skill) throw new Error(`Skill not found: ${name}`);
      return skill;
    },
    isDisabled: () => false,
    setDisabled: () => {},
  };
  const server = createGatewayServer({
    chat: { run: async () => {}, stop: () => false },
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    skillLoader: loader,
    userSkillStore: userSkills,
    userSkillStateStore: states,
    authSessions,
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    history: false,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const guestHeaders = { authorization: `Bearer ${guestToken}` };
  try {
    // admin sees full list without installed flags
    const adminList = await (await fetch(`${baseUrl}/api/skills`)).json() as { skills: Array<{ name: string; installed: boolean }> };
    assert.deepEqual(adminList.skills.map((skill) => skill.name), ['alpha', 'beta', 'gamma']);
    assert.equal(adminList.skills.every((skill) => skill.installed === false), true);

    // guest installs alpha idempotently
    assert.deepEqual(await (await post('/api/skills/install', { name: 'alpha' }, guestHeaders)).json(), { ok: true, installed: true, created: true });
    assert.deepEqual(await (await post('/api/skills/install', { name: 'alpha' }, guestHeaders)).json(), { ok: true, installed: true, created: false });
    assert.equal((await userSkills.list(guestOwner)).length, 1);
    // admin cannot install (no personal dir concept)
    assert.equal((await post('/api/skills/install', { name: 'alpha' })).status, 403);

    // guest list shows installed flag
    const guestList = await (await fetch(`${baseUrl}/api/skills`, { headers: guestHeaders })).json() as { skills: Array<{ name: string; installed: boolean; enabled: boolean }> };
    const alpha = guestList.skills.find((skill) => skill.name === 'alpha');
    assert.equal(alpha?.installed, true);
    assert.equal(alpha?.enabled, true);

    // guest toggles own installed skill
    assert.deepEqual(await (await post('/api/skills/alpha', { enabled: false }, guestHeaders)).json(), { ok: true, enabled: false });
    assert.equal(await states.isEnabled(guestOwner, 'alpha'), false);
    assert.equal(await states.isEnabled('admin', 'alpha'), true);
    // guest cannot toggle a non-installed skill
    assert.equal((await post('/api/skills/beta', { enabled: false }, guestHeaders)).status, 404);

    // guest deletes own installed skill
    const removed = await fetch(`${baseUrl}/api/skills/alpha`, { method: 'DELETE', headers: guestHeaders });
    assert.deepEqual(await removed.json(), { ok: true, deleted: true });
    assert.equal((await userSkills.list(guestOwner)).length, 0);
    // admin cannot delete (no personal dir concept)
    assert.equal((await fetch(`${baseUrl}/api/skills/alpha`, { method: 'DELETE' })).status, 403);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('distilled skill API isolates admin and guest owners while preserving validation and state cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-user-skill-admin-'));
  const userSkills = new UserSkillStore(join(directory, 'user-skills'));
  const states = new UserSkillStateStore(join(directory, 'skill-states'));
  const authSessions = new AuthSessionStore(join(directory, 'auth.json'));
  const guestToken = await authSessions.create('Distilled Guest', 'guest');
  const guestOwner = guestIdForUsername('Distilled Guest');
  await userSkills.save('zeta', 'later', source('later', 'Later workflow'));
  await userSkills.save('admin', 'second', source('second', 'Second workflow'));
  await userSkills.save('admin', 'first', source('first', 'First workflow'));
  await userSkills.save(guestOwner, 'guest-second', source('guest-second', 'Guest second workflow'));
  await userSkills.save(guestOwner, 'guest-first', source('guest-first', 'Guest first workflow'));
  await states.setEnabled('admin', 'second', false);
  await states.setEnabled(guestOwner, 'guest-second', false);
  const server = createGatewayServer({
    chat: { run: async () => {}, stop: () => false },
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    userSkillStore: userSkills,
    userSkillStateStore: states,
    authSessions,
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    history: false,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const listed = await (await fetch(`${baseUrl}/api/user-skills`)).json() as {
      skills: Array<{ name: string; description: string; owner: string; enabled: boolean }>;
    };
    assert.deepEqual(listed.skills, [
      { name: 'first', description: 'First workflow', owner: 'admin', enabled: true },
      { name: 'second', description: 'Second workflow', owner: 'admin', enabled: false },
    ]);

    assert.deepEqual(await (await post('/api/user-skills/admin/second', { enabled: true })).json(), { ok: true, enabled: true });
    assert.equal(await states.isEnabled('admin', 'second'), true);
    assert.equal((await post('/api/user-skills/zeta/later', { enabled: false })).status, 403);
    assert.equal((await post('/api/user-skills/Bad!/first', { enabled: false })).status, 400);
    assert.equal((await post('/api/user-skills/admin/Bad!', { enabled: false })).status, 400);
    assert.equal((await post('/api/user-skills/admin/missing', { enabled: false })).status, 404);

    await states.setEnabled('admin', 'first', false);
    const deleted = await fetch(`${baseUrl}/api/user-skills/admin/first`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), { ok: true, deleted: true });
    await assert.rejects(userSkills.read('admin', 'first'), { code: 'ENOENT' });
    assert.equal(await states.isEnabled('admin', 'first'), true);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/admin/first`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/Bad!/first`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/admin/Bad!`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/zeta/later`, { method: 'DELETE' })).status, 403);

    const guestHeaders = { authorization: `Bearer ${guestToken}` };
    const guestListedResponse = await fetch(`${baseUrl}/api/user-skills`, { headers: guestHeaders });
    assert.equal(guestListedResponse.status, 200);
    const guestListed = await guestListedResponse.json() as {
      skills: Array<{ name: string; description: string; owner: string; enabled: boolean }>;
    };
    assert.deepEqual(guestListed.skills, [
      { name: 'guest-first', description: 'Guest first workflow', owner: guestOwner, enabled: true },
      { name: 'guest-second', description: 'Guest second workflow', owner: guestOwner, enabled: false },
    ]);
    assert.deepEqual(
      await (await post(`/api/user-skills/${guestOwner}/guest-second`, { enabled: true }, guestHeaders)).json(),
      { ok: true, enabled: true },
    );
    assert.equal(await states.isEnabled(guestOwner, 'guest-second'), true);
    assert.equal((await post(`/api/user-skills/${guestOwner}/missing`, { enabled: false }, guestHeaders)).status, 404);
    assert.equal((await post('/api/user-skills/Bad!/guest-first', { enabled: false }, guestHeaders)).status, 400);
    assert.equal((await post(`/api/user-skills/${guestOwner}/Bad!`, { enabled: false }, guestHeaders)).status, 400);
    assert.equal((await post('/api/user-skills/admin/second', { enabled: false }, guestHeaders)).status, 403);
    assert.equal((await post('/api/user-skills/zeta/later', { enabled: false }, guestHeaders)).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/admin/second`, { method: 'DELETE', headers: guestHeaders })).status, 403);
    await states.setEnabled(guestOwner, 'guest-first', false);
    const guestDeleted = await fetch(`${baseUrl}/api/user-skills/${guestOwner}/guest-first`, { method: 'DELETE', headers: guestHeaders });
    assert.deepEqual(await guestDeleted.json(), { ok: true, deleted: true });
    await assert.rejects(userSkills.read(guestOwner, 'guest-first'), { code: 'ENOENT' });
    assert.equal(await states.isEnabled(guestOwner, 'guest-first'), true);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/${guestOwner}/guest-first`, { method: 'DELETE', headers: guestHeaders })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/Bad!/guest-second`, { method: 'DELETE', headers: guestHeaders })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/${guestOwner}/Bad!`, { method: 'DELETE', headers: guestHeaders })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/user-skills/zeta/later`, { method: 'DELETE', headers: guestHeaders })).status, 403);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('per-user skill state persists and gateway context reflects disable, enable, and delete on the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-skill-context-'));
  const userSkills = new UserSkillStore(join(directory, 'user-skills'));
  const stateRoot = join(directory, 'skill-states');
  const states = new UserSkillStateStore(stateRoot);
  const owner = guestIdForUsername('context-user');
  await userSkills.save(owner, 'personal-flow', source('personal-flow', 'Personal workflow', 'PERSONAL_CONTEXT_SENTINEL'));
  const systemLoader = { list: async () => [], load: async () => { throw new Error('missing'); }, isDisabled: () => false, setDisabled: () => {} };
  const memory = new MemoryStore(join(directory, 'memory.md'));
  let prompt = '';
  const app = {
    config: { ...structuredClone(DEFAULT_CONFIG), autoLoadSkills: true },
    memory,
    skills: systemLoader,
    userSkills,
    userSkillStates: states,
    context: new AgentContext(memory, systemLoader as never),
    run: async (_message: string, options: { context?: AgentContext }) => { prompt = await options.context!.systemPrompt(); return 'ok'; },
    interrupt: { cancel: () => false },
  } as unknown as TaiweiApp;
  const bridge = new AgentChatBridge(app);
  const sink: ChatSink = { event: () => {}, error: (error) => { throw error; } };
  try {
    await bridge.run('one', sink, [], undefined, undefined, 'build', 'guest', 'context-user', undefined, undefined, undefined, undefined, undefined, undefined, owner);
    assert.match(prompt, /personal-flow: Personal workflow/);

    await states.setEnabled(owner, 'personal-flow', false);
    assert.equal(await new UserSkillStateStore(stateRoot).isEnabled(owner, 'personal-flow'), false);
    await bridge.run('two', sink, [], undefined, undefined, 'build', 'guest', 'context-user', undefined, undefined, undefined, undefined, undefined, undefined, owner);
    assert.doesNotMatch(prompt, /personal-flow/);

    await states.setEnabled(owner, 'personal-flow', true);
    await bridge.run('three', sink, [], undefined, undefined, 'build', 'guest', 'context-user', undefined, undefined, undefined, undefined, undefined, undefined, owner);
    assert.match(prompt, /personal-flow/);

    assert.equal(await userSkills.delete(owner, 'personal-flow'), true);
    await states.remove(owner, 'personal-flow');
    await bridge.run('four', sink, [], undefined, undefined, 'build', 'guest', 'context-user', undefined, undefined, undefined, undefined, undefined, undefined, owner);
    assert.doesNotMatch(prompt, /personal-flow/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
