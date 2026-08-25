import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatBridge } from '../src/gateway/chat.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { FolderStore, folderDirName, guestFolderName, workspaceFolderMetadata } from '../src/gateway/folders.js';
import { closeGateway, createGatewayServer, listenGateway, type GatewayModelState } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { DEFAULT_CONFIG, type TaiweiConfig } from '../src/config/config.js';
import { installGatewayTestAdminAuth } from './gateway-test-auth.js';

installGatewayTestAdminAuth();

function folderStore(directory: string, owner: 'admin' | 'guest', username = 'admin', workspace = join(directory, 'workspace')): FolderStore {
  const guestName = guestFolderName(username);
  return new FolderStore({
    file: join(directory, 'folders.json'),
    owner,
    rootPath: owner === 'guest' ? workspace : join(directory, 'workspaces', 'admin'),
    defaultId: owner === 'guest' ? 'guest-default' : 'admin-default',
    defaultName: owner === 'guest' ? guestName : 'workspace',
    defaultDirName: owner === 'guest' ? guestName : 'workspace',
    defaultPath: () => workspace,
  });
}

test('folder stores lazily create dynamic admin and md5 guest defaults and support CRUD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-folders-store-'));
  try {
    let adminWorkspace = join(directory, 'workspace-one');
    const admin = new FolderStore({
      file: join(directory, 'admin-folders.json'), owner: 'admin', rootPath: join(directory, 'workspaces', 'admin'),
      defaultId: 'admin-default', defaultName: 'workspace-one', defaultDirName: folderDirName('workspace-one'), defaultPath: () => adminWorkspace,
    });
    const adminDefault = await admin.defaultFolder();
    assert.equal(adminDefault.name, 'workspace-one');
    assert.notEqual(adminDefault.name, 'pt-workspace');
    assert.equal(adminDefault.path, adminWorkspace);
    assert.equal(adminDefault.system, true);
    assert.equal((await stat(adminWorkspace)).isDirectory(), true);
    adminWorkspace = join(directory, 'workspace-two');
    assert.equal((await admin.defaultFolder()).path, adminWorkspace, 'the configured workspace is resolved on every read');

    const parent = await admin.create('Project Alpha');
    const child = await admin.create('Nested', parent.id);
    assert.equal(child.parentId, parent.id);
    assert.match(parent.dirName, /^[a-zA-Z0-9_-]+$/);
    assert.equal((await admin.rename(parent.id, 'Project Beta'))?.name, 'Project Beta');
    await assert.rejects(admin.rename(adminDefault.id, 'renamed'), /System folders/);
    await assert.rejects(admin.create('Project Beta'), /already exists/);
    await assert.rejects(admin.delete(parent.id), /sub-folders/);
    assert.equal(await admin.delete(child.id), true);
    assert.equal(await admin.delete(parent.id), true);

    const username = 'The quick brown fox';
    const guest = folderStore(join(directory, 'guest'), 'guest', username);
    const guestDefault = await guest.defaultFolder();
    assert.equal(guestDefault.name, 'a2004f37730b9445670a738fa0fc9ee5');
    assert.equal(guestDefault.name, guestFolderName(username));
    assert.equal(guestDefault.owner, 'guest');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('admin folder metadata uses the configured workspace basename', () => {
  assert.deepEqual(workspaceFolderMetadata('/srv/taiwei/workspace'), { name: 'workspace', dirName: 'workspace' });
  assert.deepEqual(workspaceFolderMetadata('/srv/taiwei/My Workspace'), { name: 'My Workspace', dirName: 'my-workspace' });
  assert.deepEqual(workspaceFolderMetadata('/'), { name: 'workspace', dirName: 'workspace' });
});

test('folder store persists migration of the legacy admin pt-workspace default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-folders-migration-'));
  const file = join(directory, 'folders.json');
  const workspace = join(directory, 'My Workspace');
  try {
    await writeFile(file, `${JSON.stringify([{ id: 'admin-default', name: 'pt-workspace', path: join(directory, 'old'), dirName: 'pt-workspace', system: true, owner: 'admin', default: true }], null, 2)}\n`);
    const store = new FolderStore({
      file, owner: 'admin', rootPath: join(directory, 'workspaces'), defaultId: 'admin-default',
      defaultName: 'My Workspace', defaultDirName: folderDirName('My Workspace'), defaultPath: () => workspace,
    });
    const migrated = await store.defaultFolder();
    assert.equal(migrated.name, 'My Workspace');
    assert.equal(migrated.dirName, 'my-workspace');
    assert.equal(migrated.path, workspace);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as Array<{ name: string; path: string }>;
    assert.deepEqual(persisted.map(({ name, path }) => ({ name, path })), [{ name: 'My Workspace', path: workspace }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('folder APIs assign sessions, reject system rename, move sessions on delete, and thread workspaceRoot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-folders-api-'));
  const workspace = join(directory, 'configured-workspace');
  const folders = folderStore(join(directory, 'admin'), 'admin', 'admin', workspace);
  const sessions = new SessionStore(join(directory, 'sessions'));
  const workspaceRoots: Array<string | undefined> = [];
  const chat: ChatBridge = {
    run: async (...args) => { workspaceRoots.push(args[11]); args[1].event({ type: 'done', text: 'ok' }); },
    stop: () => false,
  };
  const modelState: GatewayModelState = {
    getCurrentModel: async () => 'test-model',
    resolveModels: async () => ({ models: ['test-model'], current: 'test-model', source: 'config' }),
    setCurrentModel: async () => {},
  };
  const config = structuredClone(DEFAULT_CONFIG) as TaiweiConfig;
  config.workspace.dir = workspace;
  const server = createGatewayServer({
    chat, sessions, modelState, contextWindow: () => 10_000,
    configState: { load: async () => structuredClone(config), save: async () => {} },
    folderStoreFactory: () => folders,
    uploadsDirectory: join(directory, 'uploads'), history: false, log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const defaults = await (await fetch(`${baseUrl}/api/folders`)).json() as Array<{ id: string; system: boolean; default: boolean }>;
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].default, true);

    const createdFolderResponse = await fetch(`${baseUrl}/api/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API project' }),
    });
    assert.equal(createdFolderResponse.status, 201);
    const createdFolder = await createdFolderResponse.json() as { id: string; path: string };
    const createdSession = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: createdFolder.id }),
    })).json() as { id: string; folderId: string };
    assert.equal(createdSession.folderId, createdFolder.id);

    const chatResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: createdSession.id }),
    });
    assert.equal(chatResponse.status, 200);
    await chatResponse.text();
    assert.deepEqual(workspaceRoots, [createdFolder.path]);

    const systemRename = await fetch(`${baseUrl}/api/folders/${defaults[0].id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope' }),
    });
    assert.equal(systemRename.status, 403);

    const removed = await fetch(`${baseUrl}/api/folders/${createdFolder.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, movedSessions: 1, destinationFolderId: defaults[0].id });
    const movedSession = await (await fetch(`${baseUrl}/api/sessions/${createdSession.id}`)).json() as { folderId: string };
    assert.equal(movedSession.folderId, defaults[0].id);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest folder routes are allowed and isolated with an md5 username default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-folders-guest-'));
  const username = 'Alice.Example';
  const guestFolders = folderStore(join(directory, 'guest'), 'guest', username);
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const token = await authSessions.create(username, 'guest');
  const config = structuredClone(DEFAULT_CONFIG) as TaiweiConfig;
  const server = createGatewayServer({
    chat: { run: async () => {}, stop: () => false },
    auth: { enabled: true, username: 'admin', password: 'secret' }, authSessions,
    configState: { load: async () => structuredClone(config), save: async () => {} },
    folderStoreFactory: () => guestFolders,
    uploadsDirectory: join(directory, 'uploads'), history: false, log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const headers = { authorization: `Bearer ${token}` };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/folders`, { headers });
    assert.equal(response.status, 200);
    const listed = await response.json() as Array<{ name: string; owner: string; default: boolean }>;
    assert.deepEqual(listed.map(({ name, owner, default: isDefault }) => ({ name, owner, default: isDefault })), [
      { name: guestFolderName(username), owner: 'guest', default: true },
    ]);
    const created = await fetch(`http://127.0.0.1:${port}/api/folders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'guest project' }),
    });
    assert.equal(created.status, 201);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest folder store caps top-level projects at maxProjects while admin is unlimited and subfolders are free', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-folders-cap-'));
  try {
    const limited = folderStore(directory, 'guest', 'capuser');
    const unlimitedAdmin = new FolderStore({
      file: join(directory, 'admin-cap.json'), owner: 'admin', rootPath: join(directory, 'workspaces', 'admin'),
      defaultId: 'admin-default', defaultName: 'workspace', defaultDirName: 'workspace', defaultPath: () => join(directory, 'workspace'),
    });
    // guest 限制为 2（用 2 验证逻辑，生产用 9）
    limited['options' as never] = { ...(limited as never as { options: object })['options'], maxProjects: 2 } as never;
    const a = await limited.create('A');
    const b = await limited.create('B');
    await assert.rejects(limited.create('C'), /项目数量已达上限/);
    // 子文件夹不计入上限
    await limited.create('Nested', a.id);
    // admin 不受限
    await unlimitedAdmin.create('X'); await unlimitedAdmin.create('Y'); await unlimitedAdmin.create('Z');
    const listed = await unlimitedAdmin.list();
    assert.ok(listed.filter((f) => !f.system).length >= 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
