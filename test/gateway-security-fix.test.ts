import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, type TaiweiConfig } from '../src/config/config.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import type { ChatBridge } from '../src/gateway/chat.js';
import { guestIdForShareToken, guestIdForUsername, closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';

const chat: ChatBridge = { run: async () => {}, stop: () => false };

test('gateway API is fail-closed even when every login mechanism is disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-auth-closed-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth.enabled = false;
  config.oauth.enabled = false;
  config.share.enabled = false;
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const token = await authSessions.create('admin', 'admin');
  const server = createGatewayServer({
    chat, authSessions, tenantAccounts: false,
    configState: { load: async () => structuredClone(config), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/folders`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('share mode rejects anonymous and incorrect credentials and grants valid shares guest-only access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-share-auth-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const config = structuredClone(DEFAULT_CONFIG);
  config.share = { enabled: true, token: 'correct-share-token', createdAt: new Date().toISOString() };
  const server = createGatewayServer({
    chat, tenantAccounts: false,
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    configState: { load: async () => structuredClone(config), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: { 'x-share-token': 'wrong-share-token' } })).status, 401);

    const valid = await fetch(`${baseUrl}/api/sessions`, { headers: { 'x-share-token': config.share.token } });
    assert.equal(valid.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/settings`, { headers: { 'x-share-token': config.share.token } })).status, 403);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest cannot mutate global settings or model and local upload groups are identity-prefixed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-guest-global-state-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const guestToken = await authSessions.create('alice', 'guest');
  const adminToken = await authSessions.create('admin', 'admin');
  const config = structuredClone(DEFAULT_CONFIG);
  let globalModel = 'initial-model';
  const server = createGatewayServer({
    chat, tenantAccounts: false, authSessions, uploadsDirectory: join(directory, 'uploads'),
    configState: { load: async () => structuredClone(config), save: async (next) => { Object.assign(config, structuredClone(next)); } },
    modelState: {
      getCurrentModel: async () => globalModel,
      resolveModels: async () => ({ models: ['initial-model', 'next-model'], current: globalModel, source: 'config' }),
      setCurrentModel: async (model) => { globalModel = model; },
    },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const guestHeaders = { authorization: `Bearer ${guestToken}` };
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  try {
    const settings = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST', headers: { ...guestHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: { dir: join(directory, 'hijacked') } }),
    });
    assert.equal(settings.status, 403);

    const model = await fetch(`${baseUrl}/api/model`, {
      method: 'POST', headers: { ...guestHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'next-model' }),
    });
    assert.equal(model.status, 403);
    assert.equal(globalModel, 'initial-model');

    const guestUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { ...guestHeaders, 'x-file-name': 'guest.txt', 'x-session-id': 'shared-group' }, body: 'guest',
    });
    assert.equal(guestUpload.status, 201);
    const guestPath = (await guestUpload.json() as { path: string }).path;
    assert.equal(guestPath.split('/').at(-2), `${guestIdForUsername('alice')}-shared-group`);

    const adminUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { ...adminHeaders, 'x-file-name': 'admin.txt', 'x-session-id': 'shared-group' }, body: 'admin',
    });
    assert.equal(adminUpload.status, 201);
    const adminPath = (await adminUpload.json() as { path: string }).path;
    assert.equal(adminPath.split('/').at(-2), 'shared-group');
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest storage keys resist slug and share-prefix collisions', () => {
  assert.notEqual(guestIdForUsername('Alice.Example'), guestIdForUsername('alice-example'));
  assert.notEqual(guestIdForUsername('A'.repeat(80)), guestIdForUsername(`${'A'.repeat(79)}B`));
  assert.notEqual(guestIdForUsername('!!!'), guestIdForUsername('???'));
  assert.notEqual(guestIdForShareToken('12345678-token-one'), guestIdForShareToken('12345678-token-two'));
  assert.match(guestIdForShareToken('token'), /^guest-share-[a-f0-9]{24}$/);
});

test('guest responses redact host paths, identity snapshots and context while preserving tool calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-guest-dto-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const username = 'Alice.Example';
  const guestId = guestIdForUsername(username);
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const token = await authSessions.create(username, 'guest');
  const guestSessions = new SessionStore(join(directory, 'guests', guestId, 'sessions'));
  const session = await guestSessions.create('build', 'guest-default', 'model', 'provider', {
    role: 'guest', username, accountName: 'secret-account', osUsername: 'secret-os', giteaUsername: 'secret-gitea',
  });
  session.contextMessages = [{ role: 'system', content: 'secret context' }];
  session.messages.push({
    role: 'user', content: 'hello', timestamp: new Date().toISOString(),
    attachments: [{ name: 'secret.txt', url: '/home/secret/private.txt', type: 'text/plain' }],
  }, {
    role: 'assistant', content: 'done', timestamp: new Date().toISOString(),
    toolCalls: [{ name: 'bash', args: { command: 'cat /home/secret/private.txt' }, result: 'secret result' }],
  }, {
    role: 'assistant', content: 'image ready', timestamp: new Date().toISOString(),
    toolCalls: [{ name: 'generate_image', args: { prompt: 'sunset' }, result: '![image](https://cdn.example/generated.png)' }],
  });
  await guestSessions.save(session);
  const config: TaiweiConfig = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'secret' };
  const server = createGatewayServer({
    chat, auth: config.auth, authSessions, tenantAccounts: false,
    configState: { load: async () => structuredClone(config), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const headers = { authorization: `Bearer ${token}` };
  try {
    const folders = await (await fetch(`http://127.0.0.1:${port}/api/folders`, { headers })).json() as Array<Record<string, unknown>>;
    assert.equal(folders[0]?.path, undefined);
    assert.equal(folders[0]?.dirName, undefined);
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, { headers })).json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    assert.equal(body.identity, undefined);
    assert.equal(body.contextMessages, undefined);
    assert.doesNotMatch(serialized, /secret-account|secret-os|secret-gitea|secret context/);
    assert.match(serialized, /"name":"bash"/);
    assert.match(serialized, /cat \/home\/secret\/private\.txt/);
    assert.match(serialized, /secret result/);
    assert.match(serialized, /"name":"generate_image","args":\{"prompt":"sunset"\},"result":"!\[image\]\(https:\/\/cdn\.example\/generated\.png\)"/);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy guest directory is migrated once to the hashed storage key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-guest-migrate-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const username = 'Legacy.User';
  const legacyId = 'guest-legacy-user';
  const nextId = guestIdForUsername(username);
  const legacyDirectory = join(directory, 'guests', legacyId);
  const oldWorkspace = join(legacyDirectory, 'workspace');
  await mkdir(oldWorkspace, { recursive: true });
  await writeFile(join(oldWorkspace, 'kept.txt'), 'kept');
  await writeFile(join(legacyDirectory, 'folders.json'), `${JSON.stringify([{
    id: 'guest-default', name: 'legacy', path: oldWorkspace, dirName: 'legacy', system: true, owner: 'guest', default: true,
  }])}\n`);
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const token = await authSessions.create(username, 'guest');
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'secret' };
  const server = createGatewayServer({
    chat, auth: config.auth, authSessions, tenantAccounts: false,
    configState: { load: async () => structuredClone(config), save: async () => {} }, log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/folders`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await stat(join(directory, 'guests', nextId, 'workspace', 'kept.txt'))).isFile(), true);
    const migrated = JSON.parse(await readFile(join(directory, 'guests', nextId, 'folders.json'), 'utf8')) as Array<{ path: string }>;
    assert.equal(migrated[0]?.path, join(directory, 'guests', nextId, 'workspace'));
    await assert.rejects(stat(legacyDirectory), { code: 'ENOENT' });
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
