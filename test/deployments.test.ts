import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import type { ChatBridge } from '../src/gateway/chat.js';
import { DeploymentStore, validateDeploymentInput, type DeploymentDoctorResult } from '../src/gateway/deployments.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import type { TenantAccountService } from '../src/gateway/tenants.js';
import { installGatewayTestAdminAuth } from './gateway-test-auth.js';

installGatewayTestAdminAuth();

const chat: ChatBridge = {
  async run() { throw new Error('测试不应执行聊天'); },
  stop() { return false; },
};

function deploymentBody(home: string, ownerHash: string, name = 'demo') {
  return {
    name,
    ownerHash,
    path: `/taiwei/${ownerHash}/${name}/`,
    port: 18_081,
    dir: join(home, 'projects', ownerHash, name),
    status: 'running',
    url: `https://example.test/taiwei/${ownerHash}/${name}/`,
    repo: `owner/${name}`,
  };
}

test('deployment API registers, filters, diagnoses and safely cleans records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-deployments-api-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const store = new DeploymentStore(join(directory, 'history.db'));
  const inspected: string[] = [];
  const cleaned: string[] = [];
  const server = createGatewayServer({
    chat,
    deployments: store,
    tenantAccounts: false,
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    deploymentInspect: async (deployment): Promise<DeploymentDoctorResult> => {
      inspected.push(deployment.name);
      return {
        deployment,
        desired: { status: deployment.status, port: deployment.port, path: deployment.path, dir: deployment.dir },
        observed: {
          port: { state: 'listening', listening: true, pids: [1234], message: '测试端口正在监听' },
          nginx: { state: 'configured', configured: true, message: '测试 location 存在' },
          directory: { state: 'present', exists: true, message: '测试目录存在' },
        },
        healthy: true,
      };
    },
    deploymentCleanup: async (deployment) => {
      cleaned.push(deployment.name);
      return [
        { step: 'stop_port', status: 'ok', message: '测试停止端口' },
        { step: 'delete_files', status: 'ok', message: '测试删除目录' },
        { step: 'remove_nginx', status: 'ok', message: '测试移除 nginx' },
      ];
    },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerHash = '8c6976e5';
  try {
    const created = await fetch(`${baseUrl}/api/deployments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deploymentBody(directory, ownerHash)),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json() as { ownerHash: string }).ownerHash, ownerHash);

    const listed = await (await fetch(`${baseUrl}/api/deployments?ownerHash=${ownerHash}`)).json() as Array<{ name: string; status: string }>;
    assert.deepEqual(listed.map(({ name, status }) => ({ name, status })), [{ name: 'demo', status: 'running' }]);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/deployments?ownerHash=aaaaaaaa`)).json(), []);

    const doctor = await (await fetch(`${baseUrl}/api/deployments/doctor?ownerHash=${ownerHash}`)).json() as DeploymentDoctorResult[];
    assert.equal(doctor.length, 1);
    assert.equal(doctor[0]?.healthy, true);
    assert.equal(doctor[0]?.observed.port.listening, true);
    assert.deepEqual(inspected, ['demo']);

    const removed = await fetch(`${baseUrl}/api/deployments/demo?ownerHash=${ownerHash}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const cleanup = await removed.json() as { ok: boolean; steps: Array<{ status: string }>; deployment: { status: string } };
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.steps.length, 3);
    assert.equal(cleanup.deployment.status, 'cleaned');
    assert.deepEqual(cleaned, ['demo']);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest deployment API rejects another ownerHash and accepts its own hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-deployments-guest-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const token = await authSessions.create('alice', 'guest');
  const ownHash = createHash('sha256').update('alice').digest('hex').slice(0, 8);
  const otherHash = 'deadbeef';
  const store = new DeploymentStore(join(directory, 'history.db'));
  const config = structuredClone(DEFAULT_CONFIG);
  const server = createGatewayServer({
    chat,
    deployments: store,
    authSessions,
    tenantAccounts: false,
    configState: { load: async () => config, save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    await mkdir(join(directory, 'projects', otherHash, 'foreign'), { recursive: true });
    const foreign = await fetch(`${baseUrl}/api/deployments`, {
      method: 'POST', headers, body: JSON.stringify(deploymentBody(directory, otherHash, 'foreign')),
    });
    assert.equal(foreign.status, 403);

    await mkdir(join(directory, 'projects', ownHash, 'mine'), { recursive: true });
    const own = await fetch(`${baseUrl}/api/deployments`, {
      method: 'POST', headers, body: JSON.stringify(deploymentBody(directory, ownHash, 'mine')),
    });
    assert.equal(own.status, 200);
    const listed = await (await fetch(`${baseUrl}/api/deployments`, { headers })).json() as Array<{ ownerHash: string; name: string }>;
    assert.deepEqual(listed.map(({ ownerHash, name }) => ({ ownerHash, name })), [{ ownerHash: ownHash, name: 'mine' }]);
    assert.equal((await fetch(`${baseUrl}/api/deployments?ownerHash=${otherHash}`, { headers })).status, 403);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment cleanup limits guest project roots to their tenant while admin retains all roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-deployments-tenant-cleanup-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const tenantHomeRoot = join(directory, 'home');
  const accounts = [
    { username: 'alice', osUsername: 'guest1' },
    { username: 'bob', osUsername: 'guest2' },
  ];
  const tenantAccounts = {
    store: {
      initialize: async () => {},
      listAccounts: async () => accounts,
      getByUsername: async (username: string) => accounts.find((account) => account.username === username),
      close: () => {},
    },
  } as unknown as TenantAccountService;
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const guestToken = await authSessions.create('alice', 'guest');
  const adminToken = await authSessions.create('admin', 'admin');
  const ownHash = createHash('sha256').update('guest1').digest('hex').slice(0, 8);
  const otherHash = createHash('sha256').update('guest2').digest('hex').slice(0, 8);
  const guest1Root = join(tenantHomeRoot, 'guest1', 'projects');
  const guest2Root = join(tenantHomeRoot, 'guest2', 'projects');
  const store = new DeploymentStore(join(directory, 'history.db'));
  await store.initialize();
  const record = (name: string, ownerHash: string, dir: string, port: number) => ({
    name, ownerHash, path: `/taiwei/${ownerHash}/${name}/`, port, dir, status: 'running' as const,
    url: `/taiwei/${ownerHash}/${name}/`, repo: null,
  });
  await store.upsertDeployment(record('mine', ownHash, join(guest1Root, 'mine'), 19_101));
  // Simulate a legacy/compromised record whose ownerHash is Alice's but directory belongs to Bob.
  await store.upsertDeployment(record('poison', ownHash, join(guest2Root, 'poison'), 19_102));
  await store.upsertDeployment(record('other', otherHash, join(guest2Root, 'other'), 19_103));
  const seenRoots = new Map<string, readonly string[]>();
  const server = createGatewayServer({
    chat, deployments: store, authSessions, tenantAccounts, tenantHomeRoot,
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    deploymentCleanup: async (deployment, options) => {
      seenRoots.set(deployment.name, options.guestProjectsRoots);
      const allowed = options.guestProjectsRoots.some((root) => deployment.dir.startsWith(`${root}/`));
      return [{ step: 'delete_files', status: allowed ? 'ok' : 'failed', message: allowed ? 'allowed' : 'refused' }];
    },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const guestHeaders = { authorization: `Bearer ${guestToken}` };
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  try {
    const own = await fetch(`${baseUrl}/api/deployments/mine?ownerHash=${ownHash}`, { method: 'DELETE', headers: guestHeaders });
    assert.equal(own.status, 200);
    assert.equal((await own.json() as { ok: boolean }).ok, true);
    assert.deepEqual(seenRoots.get('mine'), [guest1Root]);

    const foreignOwner = await fetch(`${baseUrl}/api/deployments/other?ownerHash=${otherHash}`, { method: 'DELETE', headers: guestHeaders });
    assert.equal(foreignOwner.status, 403);

    const poisoned = await fetch(`${baseUrl}/api/deployments/poison?ownerHash=${ownHash}`, { method: 'DELETE', headers: guestHeaders });
    assert.equal(poisoned.status, 200);
    const poisonedBody = await poisoned.json() as { ok: boolean; steps: Array<{ message: string }> };
    assert.equal(poisonedBody.ok, false);
    assert.equal(poisonedBody.steps[0]?.message, 'refused');
    assert.deepEqual(seenRoots.get('poison'), [guest1Root]);

    const admin = await fetch(`${baseUrl}/api/deployments/other?ownerHash=${otherHash}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(admin.status, 200);
    assert.equal((await admin.json() as { ok: boolean }).ok, true);
    assert.deepEqual(seenRoots.get('other'), [guest1Root, guest2Root]);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('validateDeploymentInput accepts a dir under a guest projects root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-deployments-guestdir-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const guestHash = createHash('sha256').update('guest1').digest('hex').slice(0, 8);
  const guestProjectsRoot = join(directory, 'guest-projects');
  try {
    const input = validateDeploymentInput({
      name: 'weather',
      ownerHash: guestHash,
      path: `/taiwei/${guestHash}/weather/`,
      port: 10_002,
      dir: join(guestProjectsRoot, 'weather'),
      status: 'running',
      url: `/taiwei/${guestHash}/weather/`,
    }, join(directory, 'projects'), [], [guestProjectsRoot]);
    assert.equal(input.dir, join(guestProjectsRoot, 'weather'));
    assert.equal(input.name, 'weather');
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
