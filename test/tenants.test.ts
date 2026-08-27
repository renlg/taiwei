import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, type TaiweiConfig } from '../src/config/config.js';
import { hashPassword, isScryptPassword } from '../src/config/password.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import type { ChatBridge } from '../src/gateway/chat.js';
import { closeGateway, createGatewayServer, guestIdForUsername, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { TenantAccountService, TenantAccountStore, type GiteaClient, type TenantOsProvider } from '../src/gateway/tenants.js';
import { giteaTokenFor, osUserForGuest, tenantWorkspaceForGuest } from '../src/gateway/tenant-os.js';
import type { TenantIdentity } from '../src/tools/registry.js';

const idleChat: ChatBridge = { run: async () => {}, stop: () => false };

class MockGitea implements GiteaClient {
  calls: string[] = [];
  failAt = '';
  async createUser(name: string): Promise<void> { this.calls.push(`user:${name}`); if (this.failAt === 'user') throw new Error('gitea unavailable'); }
  async createToken(name: string): Promise<string> { this.calls.push(`token:${name}`); if (this.failAt === 'token') throw new Error('token failed'); return `token-${name}`; }
  async createOrganization(name: string): Promise<void> { this.calls.push(`org:${name}`); if (this.failAt === 'org') throw new Error('org failed'); }
  async deleteOrDisableUser(name: string): Promise<void> { this.calls.push(`delete-user:${name}`); }
  async deleteOrganizationIfEmpty(name: string): Promise<'deleted'> { this.calls.push(`delete-org:${name}`); return 'deleted'; }
}

class MockOs implements TenantOsProvider {
  calls: string[] = [];
  async createAccount(name: string): Promise<void> { this.calls.push(`create:${name}`); }
  async lockAccount(name: string): Promise<void> { this.calls.push(`lock:${name}`); }
}

function tenantConfig(): TaiweiConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.gitea = { baseUrl: 'http://gitea.test/api/v1', adminToken: 'admin-token' };
  return config;
}

test('tenant store migration is idempotent, allocates sequential accounts, upserts, hides secrets, and marks deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-tenants-store-'));
  const store = new TenantAccountStore(join(directory, 'history.db'));
  try {
    await store.initialize(); await store.initialize();
    const first = await store.allocate('alice', hashPassword('os-one'), hashPassword('gitea-one'));
    const second = await store.allocate('bob', hashPassword('os-two'), hashPassword('gitea-two'));
    assert.deepEqual([first.tenantUid, first.accountName, second.tenantUid, second.accountName], [1, 'guest1', 2, 'guest2']);
    const updated = await store.upsertAccount({ ...first, status: 'active', error: 'retry me', giteaApiToken: 'secret-token' });
    assert.equal(updated.id, first.id); assert.equal((await store.getByUsername('alice'))?.error, 'retry me');
    const listed = await store.listAccounts();
    assert.equal(listed[0]?.hasGiteaToken, true);
    for (const secret of ['osPasswordHash', 'giteaPasswordHash', 'giteaApiToken']) assert.equal(Object.hasOwn(listed[0]!, secret), false);
    await store.markDeleted(first.id);
    assert.equal((await store.getByUsername('alice'))?.status, 'deleted');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ensureTenantAccount provisions in order, stores hashes only, and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-tenants-ensure-'));
  const store = new TenantAccountStore(join(directory, 'history.db'));
  const os = new MockOs(); const gitea = new MockGitea(); const config = tenantConfig();
  const service = new TenantAccountService(async () => config, store, os, () => gitea);
  try {
    const account = await service.ensureTenantAccount('alice');
    assert.equal(account.accountName, 'guest1');
    assert.deepEqual([...os.calls, ...gitea.calls], ['create:guest1', 'user:guest1', 'token:guest1', 'org:guest1']);
    assert.equal(isScryptPassword(account.osPasswordHash), true); assert.equal(isScryptPassword(account.giteaPasswordHash), true);
    assert.notEqual(account.osPasswordHash, account.giteaPasswordHash); assert.equal(account.giteaApiToken, 'token-guest1'); assert.equal(account.error, null);
    await service.ensureTenantAccount('alice');
    assert.equal(os.calls.length, 1); assert.equal(gitea.calls.length, 3);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('tenant runtime lookup exposes OS identity/token and migrates the legacy workspace idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-tenant-runtime-'));
  const store = new TenantAccountStore(join(directory, 'history.db'));
  const homeRoot = join(directory, 'home');
  const legacy = join(directory, 'guests', 'guest-alice', 'workspace');
  const foldersFile = join(directory, 'guests', 'guest-alice', 'folders.json');
  try {
    const allocated = await store.allocate('alice', 'os-hash', 'gitea-hash');
    await store.upsertAccount({ ...allocated, osProvisioned: true, giteaUserProvisioned: true,
      giteaTokenProvisioned: true, giteaOrgProvisioned: true, giteaApiToken: 'guest-token' });
    await mkdir(join(homeRoot, 'guest1'), { recursive: true });
    await mkdir(join(legacy, 'app'), { recursive: true });
    await writeFile(join(legacy, 'app', 'index.ts'), 'export {};');
    await writeFile(foldersFile, `${JSON.stringify([{ id: 'custom', name: 'app', path: join(legacy, 'app'), dirName: 'app', system: false }])}\n`);
    assert.equal(await osUserForGuest('alice', store), 'guest1');
    assert.equal(await giteaTokenFor('alice', store), 'guest-token');
    const projects = await tenantWorkspaceForGuest('alice', legacy, store, { homeRoot, foldersFile, warn: () => {} });
    assert.equal(projects, join(homeRoot, 'guest1', 'projects'));
    assert.equal(await readFile(join(projects, 'app', 'index.ts'), 'utf8'), 'export {};');
    assert.equal((JSON.parse(await readFile(foldersFile, 'utf8')) as Array<{ path: string }>)[0]?.path, join(projects, 'app'));
    assert.equal((await stat(projects)).isDirectory(), true);
    assert.equal(await tenantWorkspaceForGuest('alice', legacy, store, { homeRoot, foldersFile, warn: () => {} }), projects);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('gateway routes an authenticated tenant workspace to the OS account home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-tenant-gateway-workspace-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const store = new TenantAccountStore(join(directory, 'history.db'));
  const homeRoot = join(directory, 'home');
  const legacy = join(directory, 'guests', 'guest-alice', 'workspace');
  let workspaceRoot: string | undefined;
  let chatRole: 'admin' | 'guest' | undefined;
  let chatIdentity: string | undefined;
  let tenantIdentity: TenantIdentity | undefined;
  const chat: ChatBridge = {
    run: async (...args) => {
      chatRole = args[6]; chatIdentity = args[7]; workspaceRoot = args[11]; tenantIdentity = args[13];
      args[1].event({ type: 'done', text: 'ok' });
    },
    stop: () => false,
  };
  let server: ReturnType<typeof createGatewayServer> | undefined;
  try {
    const allocated = await store.allocate('alice', 'os-hash', 'gitea-hash');
    await store.upsertAccount({ ...allocated, osProvisioned: true, giteaUserProvisioned: true,
      giteaTokenProvisioned: true, giteaOrgProvisioned: true, giteaApiToken: 'guest-token' });
    await mkdir(join(homeRoot, 'guest1'), { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'old.txt'), 'legacy');
    const config = structuredClone(DEFAULT_CONFIG);
    config.auth = { enabled: true, username: 'admin', password: hashPassword('secret') };
    const service = new TenantAccountService(async () => config, store, new MockOs(), () => new MockGitea());
    const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
    const token = await authSessions.create('alice', 'guest');
    server = createGatewayServer({
      chat, auth: config.auth, authSessions, tenantAccounts: service, tenantHomeRoot: homeRoot,
      modelState: {
        getCurrentModel: async () => 'free',
        resolveModels: async () => ({ models: ['free'], current: 'free', source: 'config' }),
        setCurrentModel: async () => {},
      },
      configState: { load: async () => structuredClone(config), save: async () => {} }, log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const headers = { authorization: `Bearer ${token}` };
    const baseUrl = `http://127.0.0.1:${port}`;
    const session = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers })).json() as {
      id: string;
      identity?: Record<string, unknown>;
    };
    assert.equal(session.identity, undefined, 'guest API must not expose the tenant account snapshot');
    const guestSessions = new SessionStore(join(directory, 'guests', guestIdForUsername('alice'), 'sessions'));
    const storedSession = await guestSessions.get(session.id);
    assert.deepEqual(storedSession?.identity, {
      role: 'guest', username: 'alice', accountName: 'guest1', osUsername: 'guest1',
      giteaUsername: 'guest1', giteaOrgName: 'guest1-org',
    });
    for (const secret of ['osPasswordHash', 'giteaPasswordHash', 'giteaApiToken']) {
      assert.equal(Object.hasOwn(storedSession!.identity!, secret), false);
    }
    const legacySession = await guestSessions.get(session.id);
    assert.ok(legacySession); delete legacySession.identity; await guestSessions.save(legacySession);
    const repaired = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers })).json() as {
      id: string;
      identity?: Record<string, unknown>;
    };
    assert.equal(repaired.id, session.id);
    assert.equal(repaired.identity, undefined);
    assert.deepEqual((await guestSessions.get(session.id))?.identity, storedSession?.identity);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'hello' }),
    });
    assert.equal(response.status, 200); await response.text();
    assert.equal(chatRole, 'guest'); assert.equal(chatIdentity, 'alice');
    assert.deepEqual(tenantIdentity, {
      osUsername: 'guest1', giteaUsername: 'guest1', giteaOrgName: 'guest1-org',
    });
    const projects = join(homeRoot, 'guest1', 'projects');
    assert.equal(workspaceRoot, projects);
    assert.equal(await readFile(join(projects, 'old.txt'), 'utf8'), 'legacy');
    const foreignSession = await guestSessions.get(session.id);
    assert.ok(foreignSession?.identity); foreignSession.identity.username = 'bob'; await guestSessions.save(foreignSession);
    const forbidden = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'forged owner' }),
    });
    assert.equal(forbidden.status, 403); assert.deepEqual(await forbidden.json(), { error: 'forbidden' });
  } finally {
    if (server) await closeGateway(server);
    store.close();
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('tenant provisioning records Gitea failures without rejecting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-tenants-failure-'));
  const store = new TenantAccountStore(join(directory, 'history.db'));
  const gitea = new MockGitea(); gitea.failAt = 'user';
  const service = new TenantAccountService(async () => tenantConfig(), store, new MockOs(), () => gitea);
  try {
    const account = await service.ensureTenantAccount('failure-user');
    assert.match(account.error ?? '', /Gitea account creation failed.*gitea unavailable/);
    assert.equal(account.status, 'active');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('tenant account APIs are admin-only and deletion locks the OS account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-tenants-api-'));
  const store = new TenantAccountStore(join(directory, 'history.db'));
  const os = new MockOs(); const gitea = new MockGitea(); const config = tenantConfig();
  config.auth = { enabled: true, username: 'admin', password: hashPassword('secret') };
  const service = new TenantAccountService(async () => config, store, os, () => gitea);
  await service.ensureTenantAccount('alice');
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const server = createGatewayServer({
    chat: idleChat, sessions: new SessionStore(join(directory, 'sessions')), tenantAccounts: service,
    auth: config.auth, authSessions, configState: { load: async () => structuredClone(config), save: async () => {} }, log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0); const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret' }) });
    const { token } = await login.json() as { token: string }; const adminHeaders = { authorization: `Bearer ${token}` };
    const guestToken = await authSessions.create('guest-user', 'guest'); const guestHeaders = { authorization: `Bearer ${guestToken}` };
    assert.equal((await fetch(`${baseUrl}/api/tenant-accounts`, { headers: guestHeaders })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/tenant-accounts/alice`, { method: 'DELETE', headers: guestHeaders })).status, 403);
    const list = await (await fetch(`${baseUrl}/api/tenant-accounts`, { headers: adminHeaders })).json() as { accounts: Array<Record<string, unknown>> };
    assert.equal(list.accounts.length, 1); assert.equal(list.accounts[0]?.hasGiteaToken, true); assert.equal(Object.hasOwn(list.accounts[0]!, 'giteaApiToken'), false);
    assert.equal((await fetch(`${baseUrl}/api/tenant-accounts/alice`, { method: 'DELETE', headers: adminHeaders })).status, 200);
    assert.equal((await store.getByUsername('alice'))?.status, 'deleted'); assert.deepEqual(os.calls, ['create:guest1', 'lock:guest1']);
    assert.deepEqual(gitea.calls.slice(-2), ['delete-user:guest1', 'delete-org:guest1-org']);
  } finally { await closeGateway(server); await rm(directory, { recursive: true, force: true }); }
});
