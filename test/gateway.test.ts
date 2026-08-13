import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../src/agent/loop.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import type { ChatBridge, ChatSink } from '../src/gateway/chat.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import type { ChatMessage } from '../src/llm/client.js';
import type { GatewayModelState } from '../src/gateway/server.js';

class MockChat implements ChatBridge {
  stopped = false;
  histories: ChatMessage[][] = [];

  async run(_message: string, sink: ChatSink, history: ChatMessage[] = []): Promise<void> {
    this.histories.push(history);
    for (const event of [
      { type: 'token', text: 'Hello ' },
      { type: 'tool', name: 'read', args: { path: 'README.md' } },
      { type: 'tool_result', name: 'read', result: 'contents' },
      { type: 'token', text: 'world' },
      { type: 'done', text: 'Hello world' },
    ] satisfies AgentEvent[]) sink.event(event);
  }

  stop(): boolean { this.stopped = true; return true; }
}

test('gateway serves health, static UI, and streamed SSE events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>taiwei test</title>');
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
  const server = createGatewayServer({ chat: mock, sessions, modelState, publicDirectory: directory, log: () => {} });
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
    assert.deepEqual(await switched.json(), { ok: true, current: 'free' });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/model`)).json(), { current: 'free' });
    const unknown = await fetch(`${baseUrl}/api/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'missing' }),
    });
    assert.equal(unknown.status, 400);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /taiwei test/);

    const stylesheet = await fetch(`${baseUrl}/style.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);

    const logo = await fetch(`${baseUrl}/logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; title: string };
    assert.equal(created.title, '新会话');

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: created.id }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await chat.text();
    assert.match(body, /event: token\ndata: \{"text":"Hello "\}/);
    assert.match(body, /event: tool\ndata: \{"name":"read","args":\{"path":"README.md"\}\}/);
    assert.match(body, /event: tool_result/);
    assert.match(body, new RegExp(`event: done\\ndata: \\{"text":"Hello world","sessionId":"${created.id}"\\}`));

    const detail = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const persisted = await detail.json() as { title: string; messages: Array<{ role: string; content: string; toolCalls?: unknown[] }> };
    assert.equal(persisted.title, 'hello');
    assert.deepEqual(persisted.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hello world' },
    ]);
    assert.equal(persisted.messages[1].toolCalls?.length, 1);

    const secondChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'again', sessionId: created.id }),
    });
    assert.equal(secondChat.status, 200);
    await secondChat.text();
    assert.deepEqual(mock.histories[1], [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hello world' },
    ]);

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
  const options = {
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    publicDirectory: directory,
    auth: { enabled: true, username: 'admin', password: 'correct horse' },
    log: () => {},
  };
  let server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile) });
  let port = await listenGateway(server, '127.0.0.1', 0);
  let baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/models`)).status, 401);

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
    const cookieAuthorized = await fetch(`${baseUrl}/api/sessions`, { headers: { cookie: `taiwei_token=${token}` } });
    assert.equal(cookieAuthorized.status, 200);

    await closeGateway(server);
    server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile) });
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
