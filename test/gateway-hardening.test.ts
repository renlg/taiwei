import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatBridge, ChatSink } from '../src/gateway/chat.js';
import { closeGateway, createGatewayServer, formatGatewayTurnError, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { ProviderHttpError } from '../src/llm/retry.js';
import { installGatewayTestAdminAuth } from './gateway-test-auth.js';

installGatewayTestAdminAuth();

const configState = { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} };

class SlowChat implements ChatBridge {
  stopped = false;
  private resolveRun: (() => void) | undefined;
  private readonly runPromise = new Promise<void>((resolve) => { this.resolveRun = resolve; });
  async run(_message: string, sink: ChatSink): Promise<void> {
    sink.event({ type: 'token', text: 'partial' });
    await this.runPromise;
    sink.event({ type: 'done', text: 'late result' });
  }
  stop(): boolean { this.stopped = true; this.resolveRun?.(); return true; }
}

test('gateway startup finalizes stale pending session messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-stale-pending-'));
  const sessions = new SessionStore(join(directory, 'sessions'));
  try {
    const session = await sessions.create();
    session.messages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), status: 'pending' });
    await sessions.save(session);
    const server = createGatewayServer({
      chat: { run: async () => {}, stop: () => true }, sessions, history: false,
      uploadsDirectory: join(directory, 'uploads'), configState, log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    await fetch(`http://127.0.0.1:${port}/api/health`);
    const restored = await sessions.get(session.id);
    assert.equal(restored?.messages.at(-1)?.status, 'stopped');
    assert.match(restored?.messages.at(-1)?.content ?? '', /网关重启/);
    await closeGateway(server);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gateway pending timeout force-finalizes and clears a running turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-pending-timeout-'));
  const sessions = new SessionStore(join(directory, 'sessions'));
  const chat = new SlowChat();
  try {
    const server = createGatewayServer({
      chat, sessions, history: false, pendingTurnTimeoutMs: 30,
      uploadsDirectory: join(directory, 'uploads'), configState, log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };
    await (await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: created.id }),
    })).text();
    assert.equal(chat.stopped, true);
    const stoppedMessage = (await sessions.get(created.id))?.messages.at(-1);
    assert.equal(stoppedMessage?.status, 'stopped');
    assert.match(stoppedMessage?.content ?? '', /运行超时，已自动中断/);
    const pending = await (await fetch(`${baseUrl}/api/sessions/${created.id}/pending`)).json() as { running: boolean };
    assert.equal(pending.running, false);
    await closeGateway(server);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gateway formats provider errors and warns after three consecutive model failures', async () => {
  assert.equal(
    formatGatewayTurnError(new ProviderHttpError(400, 'Provider request failed (400): malformed request')),
    '模型服务请求失败（400）：malformed request。请稍后重试或切换模型。',
  );
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-model-health-'));
  const sessions = new SessionStore(join(directory, 'sessions'));
  const chat: ChatBridge = {
    async run(_message, sink) { sink.error(new ProviderHttpError(500, 'Provider is temporarily unavailable (500): overloaded')); },
    stop: () => true,
  };
  try {
    const server = createGatewayServer({
      chat, sessions, history: false, uploadsDirectory: join(directory, 'uploads'), configState, log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await (await fetch(`${baseUrl}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: `attempt ${attempt}`, sessionId: created.id }),
      })).text();
    }
    const last = (await sessions.get(created.id))?.messages.at(-1);
    assert.equal(last?.status, 'error');
    assert.match(last?.content ?? '', /模型服务暂时不可用（500）/);
    assert.match(last?.content ?? '', /当前模型已连续出错 3 次/);
    await closeGateway(server);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
