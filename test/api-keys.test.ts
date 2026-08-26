import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentContext } from '../src/agent/context.js';
import type { TaiweiApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { ApiKeyStore } from '../src/gateway/api-keys.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { AgentChatBridge, type ChatBridge } from '../src/gateway/chat.js';
import { FolderStore } from '../src/gateway/folders.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { MemoryStore } from '../src/memory/store.js';
import { CommandSecurity } from '../src/security/commands.js';
import { UserSkillStateStore } from '../src/skills/user-state.js';
import { UserSkillStore } from '../src/skills/user-store.js';
import { installGatewayTestAdminAuth, invalidGatewayAuthHeader } from './gateway-test-auth.js';

installGatewayTestAdminAuth();

interface Harness {
  directory: string;
  baseUrl: string;
  apiKeys: ApiKeyStore;
  authSessions: AuthSessionStore;
  workspace: string;
  calls: Array<{ agentId?: string; providerId?: string; model?: string; skills?: string[]; identity?: string; workspace?: string }>;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-api-keys-'));
  const workspace = join(directory, 'workspace');
  const apiKeys = new ApiKeyStore(join(directory, 'api-keys.json'));
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const calls: Harness['calls'] = [];
  const chat: ChatBridge = {
    run: async (_message, sink, _history, _sessionId, _memory, agentId, _role, identity, _runtimeSessionId, providerId, model, runWorkspace, _content, _tenant, _guestId, skills) => {
      calls.push({ agentId, providerId, model, skills, identity, workspace: runWorkspace });
      sink.event({ type: 'token', text: 'ok' });
      sink.event({ type: 'done', text: 'ok' });
    },
    stop: () => false,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'test-password' };
  config.workspace.dir = workspace;
  const systemSkills = new Set(['system-skill']);
  const server = createGatewayServer({
    chat,
    sessions: new SessionStore(join(directory, 'sessions')),
    apiKeys,
    authSessions,
    userSkillStore: new UserSkillStore(join(directory, 'user-skills')),
    skillLoader: {
      list: async () => [],
      load: async (name: string) => {
        if (!systemSkills.has(name)) throw new Error(`Skill not found: ${name}`);
        return { name, description: name, body: `${name} body`, path: join(directory, name, 'SKILL.md') };
      },
    },
    modelState: {
      getCurrentModel: async () => 'known-model',
      setCurrentModel: async () => {},
      resolveModels: async () => ({
        models: ['known-model'], current: 'known-model', currentProvider: 'test-provider', source: 'config',
        providers: [{ id: 'test-provider', name: 'Test', models: [{
          id: 'known-model', provider: 'test-provider', displayName: 'Known model',
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 8_192 },
        }] }],
      }),
    },
    contextWindow: async () => 8_192,
    configState: { load: async () => structuredClone(config), save: async () => {} },
    uploadsDirectory: join(directory, 'uploads'),
    folderStoreFactory: (identity) => new FolderStore({
      file: join(directory, `folders-${identity.role}-${identity.guestId ?? 'admin'}.json`),
      owner: identity.role,
      rootPath: workspace,
      defaultId: 'workspace',
      defaultName: 'Workspace',
      defaultDirName: 'workspace',
      defaultPath: () => workspace,
    }),
    tenantAccounts: false,
    history: false,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  return {
    directory, workspace, baseUrl: `http://127.0.0.1:${port}`, apiKeys, authSessions, calls,
    close: async () => { await closeGateway(server); await rm(directory, { recursive: true, force: true }); },
  };
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { token: string }).token;
}

function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('admin creates and lists a masked API key without persisting the raw credential', async () => {
  const app = await harness();
  try {
    const token = await login(app.baseUrl);
    const created = await post(app.baseUrl, '/api/keys', { name: 'automation', expiresInDays: 30 }, { authorization: `Bearer ${token}` });
    assert.equal(created.status, 201);
    const body = await created.json() as { key: string; record: Record<string, unknown> };
    assert.match(body.key, /^sk-[a-f0-9]{48}$/);
    assert.equal(body.key.length, 51);
    assert.equal(body.record.prefix, body.key.slice(0, 8));
    assert.equal('hash' in body.record, false);
    const persisted = await readFile(join(app.directory, 'api-keys.json'), 'utf8');
    assert.equal(persisted.includes(body.key), false);

    const listed = await fetch(`${app.baseUrl}/api/keys`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(listed.status, 200);
    const keys = (await listed.json() as { keys: Array<Record<string, unknown>> }).keys;
    assert.equal(keys.length, 1);
    assert.equal(keys[0]?.prefix, body.key.slice(0, 8));
    assert.equal('hash' in keys[0]!, false);
  } finally { await app.close(); }
});

test('API key revocation removes the record and prevents later verification', async () => {
  const app = await harness();
  try {
    const token = await login(app.baseUrl);
    const created = await (await post(app.baseUrl, '/api/keys', {}, { authorization: `Bearer ${token}` })).json() as { key: string; record: { id: string } };
    assert.ok(await app.apiKeys.verify(created.key));
    const revoked = await fetch(`${app.baseUrl}/api/keys/${encodeURIComponent(created.record.id)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await revoked.json(), { ok: true, revoked: true });
    assert.equal(await app.apiKeys.verify(created.key), undefined);
    assert.deepEqual((await fetch(`${app.baseUrl}/api/keys`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json()) as { keys: unknown[] }).keys, []);
  } finally { await app.close(); }
});

test('Bearer API key authenticates chat as admin and invalid keys fail closed', async () => {
  const app = await harness();
  try {
    const created = await app.apiKeys.create('external-client');
    const valid = await post(app.baseUrl, '/api/chat', { message: 'hello' }, { authorization: `Bearer ${created.key}` });
    assert.equal(valid.status, 200);
    assert.match(valid.headers.get('content-type') ?? '', /text\/event-stream/);
    await valid.text();
    assert.equal(app.calls[0]?.identity, 'api:external-client');
    const invalid = await post(app.baseUrl, '/api/chat', { message: 'hello' }, { ...invalidGatewayAuthHeader, 'x-api-key': 'sk-bogus' });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: 'unauthorized' });
  } finally { await app.close(); }
});

test('non-API-key guests cannot submit per-call chat overrides', async () => {
  const app = await harness();
  try {
    const guestToken = await app.authSessions.create('guest-user', 'guest');
    const response = await post(app.baseUrl, '/api/chat', {
      message: 'hello', model: 'known-model', mode: 'plan', skills: [], skipDangerous: true,
    }, { authorization: `Bearer ${guestToken}` });
    assert.equal(response.status, 403);
  } finally { await app.close(); }
});

test('API chat overrides validate model, agent profile, and skill names', async () => {
  const app = await harness();
  try {
    const created = await app.apiKeys.create('validator');
    const headers = { ...invalidGatewayAuthHeader, 'x-api-key': created.key };
    assert.equal((await post(app.baseUrl, '/api/chat', { message: 'x', model: 'missing-model' }, headers)).status, 400);
    assert.equal((await post(app.baseUrl, '/api/chat', { message: 'x', mode: 'missing-mode' }, headers)).status, 400);
    const missingSkill = await post(app.baseUrl, '/api/chat', { message: 'x', skills: ['missing-skill'] }, headers);
    assert.equal(missingSkill.status, 400);
    assert.match((await missingSkill.json() as { error: string }).error, /missing-skill/);

    const valid = await post(app.baseUrl, '/api/chat', {
      message: 'x', model: 'known-model', provider: 'test-provider', mode: 'plan', skills: ['system-skill'], skipDangerous: false,
    }, headers);
    assert.equal(valid.status, 200);
    await valid.text();
    assert.deepEqual(app.calls.at(-1), {
      agentId: 'plan', providerId: 'test-provider', model: 'known-model', skills: ['system-skill'], identity: 'api:validator',
      workspace: app.workspace,
    });
  } finally { await app.close(); }
});

test('OpenAI models endpoint returns a standard authenticated model list', async () => {
  const app = await harness();
  try {
    const key = (await app.apiKeys.create('models-client')).key;
    const valid = await fetch(`${app.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(valid.status, 200);
    const body = await valid.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, [{ id: 'known-model', object: 'model', created: 0, owned_by: 'test-provider' }]);

    const missing = await fetch(`${app.baseUrl}/v1/models`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json() as { error: { type: string } }).error.type, 'authentication_error');
    const bad = await fetch(`${app.baseUrl}/v1/models`, { headers: { authorization: 'Bearer sk-bad' } });
    assert.equal(bad.status, 401);
    const guestToken = await app.authSessions.create('guest-models', 'guest');
    const guest = await fetch(`${app.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${guestToken}` } });
    assert.equal(guest.status, 403);
    assert.equal((await guest.json() as { error: { type: string } }).error.type, 'forbidden');
  } finally { await app.close(); }
});

test('OpenAI chat completions validates requests and returns the standard non-stream shape', async () => {
  const app = await harness();
  try {
    const key = (await app.apiKeys.create('completion-client')).key;
    const headers = { authorization: `Bearer ${key}` };
    const valid = await post(app.baseUrl, '/v1/chat/completions', {
      model: 'known-model', messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'hello' }],
    }, headers);
    assert.equal(valid.status, 200);
    const body = await valid.json() as {
      object: string; choices: Array<{ message: { role: string; content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0]?.message.role, 'assistant');
    assert.equal(body.choices[0]?.message.content, 'ok');
    assert.equal(typeof body.usage.total_tokens, 'number');

    const invalid = await post(app.baseUrl, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer sk-invalid' });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json() as { error: { type: string } }).error.type, 'authentication_error');
    const missingMessages = await post(app.baseUrl, '/v1/chat/completions', {}, headers);
    assert.equal(missingMessages.status, 400);
    assert.equal((await missingMessages.json() as { error: { type: string } }).error.type, 'invalid_request_error');
    const unknownModel = await post(app.baseUrl, '/v1/chat/completions', {
      model: 'missing-model', messages: [{ role: 'user', content: 'x' }],
    }, headers);
    assert.equal(unknownModel.status, 400);
    const guestToken = await app.authSessions.create('guest-chat', 'guest');
    const guest = await post(app.baseUrl, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'x' }],
    }, { authorization: `Bearer ${guestToken}` });
    assert.equal(guest.status, 403);
  } finally { await app.close(); }
});

test('OpenAI streaming chat emits incremental delta chunks and DONE', async () => {
  const app = await harness();
  try {
    const key = (await app.apiKeys.create('stream-client')).key;
    const response = await post(app.baseUrl, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'stream this' }], stream: true,
    }, { authorization: `Bearer ${key}` });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /data: \{/);
    assert.match(body, /"delta":\{"content":"ok"\}/);
    assert.match(body, /data: \[DONE\]/);
  } finally { await app.close(); }
});

test('OpenAI extensions require API keys and forced skills reach the chat bridge', async () => {
  const app = await harness();
  try {
    const extensions = {
      messages: [{ role: 'user', content: 'x' }], mode: 'plan', skills: ['system-skill'],
      skipDangerous: false, directory: 'extension-workspace',
    };
    const loginToken = await login(app.baseUrl);
    assert.equal((await post(app.baseUrl, '/v1/chat/completions', extensions, { authorization: `Bearer ${loginToken}` })).status, 403);
    const guestToken = await app.authSessions.create('guest-extensions', 'guest');
    assert.equal((await post(app.baseUrl, '/v1/chat/completions', extensions, { authorization: `Bearer ${guestToken}` })).status, 403);

    const key = (await app.apiKeys.create('extensions-client')).key;
    const valid = await post(app.baseUrl, '/v1/chat/completions', extensions, { authorization: `Bearer ${key}` });
    assert.equal(valid.status, 200);
    assert.deepEqual(app.calls.at(-1), {
      agentId: 'plan', providerId: 'test-provider', model: 'known-model', skills: ['system-skill'],
      identity: 'api:extensions-client', workspace: join(app.workspace, 'extension-workspace'),
    });
  } finally { await app.close(); }
});

test('API-key directory overrides create relative and absolute chat workspaces', async () => {
  const app = await harness();
  try {
    const key = (await app.apiKeys.create('directory-client')).key;
    const headers = { authorization: `Bearer ${key}` };
    const relativeDirectory = 'relative-project';
    assert.equal((await post(app.baseUrl, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'x' }], directory: relativeDirectory,
    }, headers)).status, 200);
    await access(join(app.workspace, relativeDirectory));
    assert.equal(app.calls.at(-1)?.workspace, join(app.workspace, relativeDirectory));

    const absoluteDirectory = join(app.directory, 'absolute-project');
    assert.equal((await post(app.baseUrl, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'x' }], directory: absoluteDirectory,
    }, headers)).status, 200);
    await access(absoluteDirectory);
    assert.equal(app.calls.at(-1)?.workspace, absoluteDirectory);

    const legacyChat = await post(app.baseUrl, '/api/chat', { message: 'x', directory: 'legacy-api-project' }, headers);
    assert.equal(legacyChat.status, 200);
    await legacyChat.text();
    await access(join(app.workspace, 'legacy-api-project'));
    assert.equal(app.calls.at(-1)?.workspace, join(app.workspace, 'legacy-api-project'));

    const loginToken = await login(app.baseUrl);
    assert.equal((await post(app.baseUrl, '/api/chat', { message: 'x', directory: 'forbidden' }, { authorization: `Bearer ${loginToken}` })).status, 403);
  } finally { await app.close(); }
});

test('API skipDangerous confirmation decisions approve only when explicitly enabled', async () => {
  const security = structuredClone(DEFAULT_CONFIG.security);
  const commands = new CommandSecurity();
  const dangerous = 'rm -rf /tmp/taiwei-api-key-test-target';
  const approved = await commands.authorize('api:approved', dangerous, '/tmp', security, async () => ({ approve: true }));
  const rejected = await commands.authorize('api:rejected', dangerous, '/tmp', security, async () => ({ approve: false }));
  assert.equal(approved, true);
  assert.equal(rejected, false);
});

test('per-call API skills replace default user skills and can activate disabled user and system skills', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-api-skill-override-'));
  const userSkills = new UserSkillStore(join(directory, 'user-skills'));
  const userSkillStates = new UserSkillStateStore(join(directory, 'skill-states'));
  const skillSource = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`;
  await userSkills.save('admin', 'default-user', skillSource('default-user', 'DEFAULT_USER_BODY'));
  await userSkills.save('admin', 'requested-user', skillSource('requested-user', 'REQUESTED_USER_BODY'));
  await userSkillStates.setEnabled('admin', 'requested-user', false);
  const memory = new MemoryStore(join(directory, 'memory.md'));
  const systemSkill = { name: 'requested-system', description: 'requested-system', body: 'REQUESTED_SYSTEM_BODY', path: join(directory, 'requested-system', 'SKILL.md') };
  const loader = {
    list: async () => [],
    isDisabled: (skill: { name: string }) => skill.name === systemSkill.name,
    load: async (name: string) => {
      if (name !== systemSkill.name) throw new Error(`Skill not found: ${name}`);
      return systemSkill;
    },
  };
  const context = new AgentContext(memory, loader as never);
  context.activateUserSkill(await userSkills.load('admin', 'default-user'));
  let prompt = '';
  const app = {
    config: { ...structuredClone(DEFAULT_CONFIG), autoLoadSkills: true }, memory, skills: loader,
    userSkills, userSkillStates, context,
    run: async (_message: string, options: { context?: AgentContext }) => { prompt = await options.context!.systemPrompt(); return 'ok'; },
    interrupt: { cancel: () => false },
  } as unknown as TaiweiApp;
  try {
    await new AgentChatBridge(app).run('hello', { event: () => {}, error: (error) => { throw error; } }, [], undefined, undefined, 'build', 'admin', 'api:test', undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['requested-user', 'requested-system']);
    assert.match(prompt, /REQUESTED_USER_BODY/);
    assert.match(prompt, /REQUESTED_SYSTEM_BODY/);
    assert.doesNotMatch(prompt, /DEFAULT_USER_BODY/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
