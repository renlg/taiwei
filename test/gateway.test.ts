import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../src/agent/loop.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import type { ChatBridge, ChatSink } from '../src/gateway/chat.js';
import { LOGIN_COOLDOWN_MS, LoginLockStore } from '../src/gateway/login-locks.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import type { ChatMessage } from '../src/llm/client.js';
import type { GatewayModelState } from '../src/gateway/server.js';

class MockChat implements ChatBridge {
  stopped = false;
  histories: ChatMessage[][] = [];
  messages: string[] = [];

  async run(message: string, sink: ChatSink, history: ChatMessage[] = []): Promise<void> {
    this.messages.push(message);
    this.histories.push(history);
    for (const event of [
      { type: 'token', text: 'Hello ' },
      { type: 'tool', name: 'read', args: { path: 'README.md' } },
      { type: 'tool_result', name: 'read', result: 'contents' },
      { type: 'token', text: 'world' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, model: 'free' },
      { type: 'done', text: 'Hello world' },
    ] satisfies AgentEvent[]) sink.event(event);
  }

  stop(): boolean { this.stopped = true; return true; }
}

test('gateway serves health, static UI, and streamed SSE events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>taiwei test</title><img src="/logo.png?v={{ASSET_VERSION}}">');
  await writeFile(join(directory, 'app.js'), 'console.log("taiwei test")');
  await writeFile(join(directory, 'style.css'), 'body {}');
  await writeFile(join(directory, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const mock = new MockChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  let currentModel = 'good';
  const modelState: GatewayModelState = {
    getCurrentModel: async () => currentModel,
    resolveModels: async () => ({ models: ['good', 'free'], current: currentModel, source: 'config' }),
    setCurrentModel: async (model) => { currentModel = model; },
  };
  const server = createGatewayServer({
    chat: mock,
    sessions,
    modelState,
    contextWindow: async () => 1_000,
    publicDirectory: directory,
    uploadsDirectory: join(directory, 'uploads'),
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    assert.deepEqual(await (await fetch(`${baseUrl}/api/models`)).json(), { models: ['good', 'free'], current: 'good' });
    const switched = await fetch(`${baseUrl}/api/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free' }),
    });
    assert.deepEqual(await switched.json(), { ok: true, current: 'free', contextWindow: 1_000 });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/model`)).json(), { current: 'free' });
    const unknown = await fetch(`${baseUrl}/api/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(unknown.status, 400);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const pageBody = await page.text();
    assert.match(pageBody, /taiwei test/);
    assert.match(pageBody, /logo\.png\?v=4/);
    assert.doesNotMatch(pageBody, /\{\{ASSET_VERSION\}\}/);

    const stylesheet = await fetch(`${baseUrl}/style.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(stylesheet.headers.get('cache-control'), 'public, max-age=3600');

    const logo = await fetch(`${baseUrl}/logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('cache-control'), 'public, max-age=3600');
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const logoHead = await fetch(`${baseUrl}/logo.png`, { method: 'HEAD' });
    assert.equal(logoHead.status, logo.status);
    assert.equal(logoHead.headers.get('content-type'), logo.headers.get('content-type'));
    assert.equal(logoHead.headers.get('cache-control'), logo.headers.get('cache-control'));
    assert.equal(logoHead.headers.get('content-length'), logo.headers.get('content-length'));
    assert.equal((await logoHead.arrayBuffer()).byteLength, 0);

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; title: string };
    assert.equal(created.title, '新会话');

    const oversizedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'x-file-name': 'oversized.bin' }, body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    assert.equal(oversizedUpload.status, 413);

    const upload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('../notes.txt'), 'x-session-id': created.id },
      body: 'local attachment contents',
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { name: string; path: string; size: number; type: string };
    assert.equal(uploaded.name, 'notes.txt');
    assert.equal(uploaded.size, 25);
    assert.match(uploaded.path, /uploads/);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: created.id, files: [uploaded] }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await chat.text();
    assert.match(body, /event: token\ndata: \{"text":"Hello "\}/);
    assert.match(body, /event: tool\ndata: \{"name":"read","args":\{"path":"README.md"\}\}/);
    assert.match(body, /event: tool_result/);
    assert.match(body, /event: usage\ndata: \{"promptTokens":10,"completionTokens":2,"totalTokens":12,"contextWindow":1000,"model":"free"\}/);
    assert.match(body, new RegExp(`event: done\\ndata: \\{"text":"Hello world","sessionId":"${created.id}"\\}`));

    const detail = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const persisted = await detail.json() as {
      title: string;
      messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number; contextWindow: number; model: string };
    };
    assert.equal(persisted.title, 'hello');
    assert.deepEqual(persisted.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hello world' },
    ]);
    assert.match(mock.messages[0], /\[附件: notes\.txt\]/);
    assert.match(mock.messages[0], /local attachment contents/);
    assert.equal(persisted.messages[1].toolCalls?.length, 1);
    assert.deepEqual(persisted.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12, contextWindow: 1_000, model: 'free' });

    const secondChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'again', sessionId: created.id }),
    });
    assert.equal(secondChat.status, 200);
    assert.match(await secondChat.text(), /event: usage\ndata: \{"promptTokens":20,"completionTokens":4,"totalTokens":24,"contextWindow":1000,"model":"free"\}/);
    assert.match(mock.histories[1][0].content ?? '', /local attachment contents/);
    assert.deepEqual(mock.histories[1][1], { role: 'assistant', content: 'Hello world' });

    const listed = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{ id: string; messageCount: number }>;
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].messageCount, 4);

    const removed = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/sessions/${created.id}`)).status, 404);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway authenticates API requests and preserves tokens across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-auth-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>taiwei auth test</title>');
  await writeFile(join(directory, 'app.js'), '');
  await writeFile(join(directory, 'style.css'), '');
  const authFile = join(directory, 'gateway-sessions.json');
  const lockFile = join(directory, 'login-locks.json');
  const options = {
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    publicDirectory: directory,
    uploadsDirectory: join(directory, 'uploads'),
    auth: { enabled: true, username: 'admin', password: 'correct horse' },
    log: () => {},
  };
  let server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile), loginLocks: new LoginLockStore(lockFile) });
  let port = await listenGateway(server, '127.0.0.1', 0);
  let baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/models`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { 'x-file-name': 'private.txt' }, body: 'private' })).status, 401);

    const wrong = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct horse' }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json() as { token: string };
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.match(login.headers.get('set-cookie') ?? '', /taiwei_token=.*HttpOnly.*SameSite=Lax.*Max-Age=604800/);

    const authorized = await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authorized.status, 200);
    const info = await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await info.json() as { username?: string }).username, 'admin');
    const cookieAuthorized = await fetch(`${baseUrl}/api/sessions`, { headers: { cookie: `taiwei_token=${token}` } });
    assert.equal(cookieAuthorized.status, 200);
    const authorizedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-file-name': 'private.txt', 'content-type': 'text/plain' }, body: 'private',
    });
    assert.equal(authorizedUpload.status, 201);

    await closeGateway(server);
    server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile), loginLocks: new LoginLockStore(lockFile) });
    port = await listenGateway(server, '127.0.0.1', 0);
    baseUrl = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

    const logout = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway login returns 429 after five failed account and IP attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-lock-route-test-'));
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')),
    auth: { enabled: true, username: 'admin', password: 'secret' },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const login = () => fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await login()).status, 401);
    const locked = await login();
    assert.equal(locked.status, 429);
    assert.deepEqual(await locked.json(), { error: '失败次数过多，请稍后再试' });
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('login lock store enforces cooldown, permanent pair locks, IP-wide locks, and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-login-lock-store-test-'));
  const file = join(directory, 'login-locks.json');
  const store = new LoginLockStore(file);
  const start = 1_000_000;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await store.attempt('admin', 'pair-ip', false, start + attempt), { failed: true });
    }
    assert.equal((await store.attempt('admin', 'pair-ip', true, start + 10)).lock, 'pair_cooldown');

    const secondWindow = start + LOGIN_COOLDOWN_MS + 100;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await store.attempt('admin', 'pair-ip', false, secondWindow + attempt), { failed: true });
    }
    assert.equal((await store.attempt('admin', 'pair-ip', true, secondWindow + 10)).lock, 'pair_permanent');
    const restarted = new LoginLockStore(file);
    assert.equal((await restarted.attempt('admin', 'pair-ip', true, secondWindow + LOGIN_COOLDOWN_MS + 20)).lock, 'pair_permanent');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.deepEqual(await store.attempt(`user-${attempt}`, 'shared-ip', false, start + attempt), { failed: true });
    }
    assert.equal((await store.attempt('valid-user', 'shared-ip', true, start + 20)).lock, 'ip_cooldown');
    assert.deepEqual(await store.attempt('valid-user', 'shared-ip', true, start + LOGIN_COOLDOWN_MS + 30), { failed: false });

    await store.attempt('reset-user', 'reset-ip', false, start);
    assert.deepEqual(await store.attempt('reset-user', 'reset-ip', true, start + 1), { failed: false });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.deepEqual(await store.attempt('reset-user', 'reset-ip', false, start + 2 + attempt), { failed: true });
    }
    assert.deepEqual(await store.attempt('reset-user', 'reset-ip', true, start + 10), { failed: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
