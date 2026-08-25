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

test('skill store catalogs with server pagination/filtering and installs idempotently per user', async () => {
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
  try {
    const first = await (await fetch(`${baseUrl}/api/skill-store?page=1&pageSize=2`)).json() as { items: Array<{ name: string }>; total: number; totalPages: number };
    assert.deepEqual(first.items.map((item) => item.name), ['alpha', 'beta']);
    assert.equal(first.total, 3);
    assert.equal(first.totalPages, 2);
    const filtered = await (await fetch(`${baseUrl}/api/skill-store?q=NEEDLE&pageSize=1000`)).json() as { items: Array<{ name: string }>; pageSize: number };
    assert.deepEqual(filtered.items.map((item) => item.name), ['beta']);
    assert.equal(filtered.pageSize, 100);

    assert.deepEqual(await (await post('/api/skill-store/install', { name: 'alpha' })).json(), { ok: true, installed: true, created: true });
    assert.deepEqual(await (await post('/api/skill-store/install', { name: 'alpha' })).json(), { ok: true, installed: true, created: false });
    assert.equal((await userSkills.list('admin')).length, 1);

    const guestHeaders = { authorization: `Bearer ${guestToken}` };
    const guestInstall = await post('/api/skill-store/install', { name: 'alpha' }, guestHeaders);
    assert.equal(guestInstall.status, 200);
    assert.equal((await userSkills.list(guestOwner)).length, 1);
    assert.equal((await userSkills.list('admin')).length, 1);
    const guestList = await (await fetch(`${baseUrl}/api/skill-store?q=alpha`, { headers: guestHeaders })).json() as { items: Array<{ installed: boolean }> };
    assert.equal(guestList.items[0]?.installed, true);
    const disabled = await post('/api/skill-store/alpha/state', { enabled: false }, guestHeaders);
    assert.deepEqual(await disabled.json(), { ok: true, enabled: false });
    assert.equal(await new UserSkillStateStore(join(directory, 'skill-states')).isEnabled(guestOwner, 'alpha'), false);
    assert.equal(await states.isEnabled('admin', 'alpha'), true);
    assert.equal((await post('/api/skill-store/beta/state', { enabled: false }, guestHeaders)).status, 404);
    const removed = await fetch(`${baseUrl}/api/skill-store/alpha`, { method: 'DELETE', headers: guestHeaders });
    assert.deepEqual(await removed.json(), { ok: true, deleted: true });
    assert.equal((await userSkills.list(guestOwner)).length, 0);
    assert.equal((await userSkills.list('admin')).length, 1);
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
