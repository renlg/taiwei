import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import type { ChatBridge } from '../src/gateway/chat.js';
import { closeGateway, createGatewayServer, guestIdForUsername, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { closeStateDatabases, openStateDatabase } from '../src/state/db.js';

const idleChat: ChatBridge = {
  async run() { throw new Error('chat is not used by session sharing tests'); },
  stop() { return false; },
};

test('session shares are public read-only credentials isolated by owner and removed with sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'taiwei-session-sharing-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = home;
  const sessions = new SessionStore(join(home, 'sessions'));
  const authSessions = new AuthSessionStore(join(home, 'gateway-sessions.json'));
  const adminToken = await authSessions.create('admin', 'admin');
  const guestToken = await authSessions.create('alice', 'guest');
  const config = structuredClone(DEFAULT_CONFIG);
  const server = createGatewayServer({
    chat: idleChat, sessions, authSessions, tenantAccounts: false, log: () => {},
    configState: { load: async () => structuredClone(config), save: async () => {} },
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const guestHeaders = { authorization: `Bearer ${guestToken}` };
  try {
    const session = await sessions.create('build', undefined, undefined, undefined, { role: 'admin', username: 'admin' });
    session.title = '公开演示';
    session.identity = { role: 'admin', username: 'admin' };
    session.contextMessages = [{ role: 'system', content: 'private context' }];
    session.messages = [
      {
        role: 'user', content: '你好', agentContent: 'private agent content', timestamp: '2026-09-03T12:00:00.000Z',
        attachments: [{ name: 'notes.txt', type: 'text/plain', url: '/private/upload/path' }],
      },
      {
        role: 'assistant', content: '**你好！**', timestamp: '2026-09-03T12:00:01.000Z',
        toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' }, result: 'contents' }],
      },
    ];
    await sessions.save(session);

    const createdResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/share`, { method: 'POST', headers: adminHeaders });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json() as { token: string; url: string; createdAt: string; expiresAt: null };
    assert.match(created.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(created.url, `${baseUrl}/share/${created.token}`);
    assert.equal(created.expiresAt, null);

    const repeated = await (await fetch(`${baseUrl}/api/sessions/${session.id}/share`, {
      method: 'POST', headers: adminHeaders,
    })).json() as { token: string };
    assert.equal(repeated.token, created.token);
    assert.equal((await fetch(`${baseUrl}/api/sessions/${session.id}/share`, { headers: guestHeaders })).status, 404);

    const publicResponse = await fetch(`${baseUrl}/api/share/${created.token}`);
    assert.equal(publicResponse.status, 200);
    const shared = await publicResponse.json() as Record<string, unknown> & { messages: Array<Record<string, unknown>> };
    assert.equal(shared.title, '公开演示');
    assert.equal('identity' in shared, false);
    assert.equal('contextMessages' in shared, false);
    assert.deepEqual(shared.messages[0].attachments, [{ name: 'notes.txt', type: 'text/plain' }]);
    assert.equal('agentContent' in shared.messages[0], false);
    assert.deepEqual(shared.messages[1].toolCalls, [{ name: 'read_file', args: { path: 'notes.txt' } }]);
    assert.ok(!('result' in (shared.messages[1].toolCalls as Array<Record<string, unknown>>)[0]));
    assert.equal((await fetch(`${baseUrl}/api/share/not-a-valid-token`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/share/${created.token}`)).status, 200);

    const database = await openStateDatabase(join(home, 'state.db'));
    await database.serial((db) => db.prepare('UPDATE session_shares SET expires_at = ? WHERE token = ?')
      .run('2020-01-01T00:00:00.000Z', created.token));
    assert.equal((await fetch(`${baseUrl}/api/share/${created.token}`)).status, 404);
    const renewed = await (await fetch(`${baseUrl}/api/sessions/${session.id}/share`, {
      method: 'POST', headers: adminHeaders,
    })).json() as { token: string };
    assert.notEqual(renewed.token, created.token);

    assert.equal((await fetch(`${baseUrl}/api/sessions/${session.id}/share`, { method: 'DELETE', headers: adminHeaders })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/share/${renewed.token}`)).status, 404);

    const recreated = await (await fetch(`${baseUrl}/api/sessions/${session.id}/share`, {
      method: 'POST', headers: adminHeaders,
    })).json() as { token: string };
    assert.notEqual(recreated.token, created.token);
    assert.equal((await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE', headers: adminHeaders })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/share/${recreated.token}`)).status, 404);

    const guestStore = SessionStore.forGuest(guestIdForUsername('alice'));
    const guestSession = await guestStore.create('build', undefined, undefined, undefined, { role: 'guest', username: 'alice' });
    const guestShare = await fetch(`${baseUrl}/api/sessions/${guestSession.id}/share`, { method: 'POST', headers: guestHeaders });
    assert.equal(guestShare.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions/${guestSession.id}/share`, { headers: adminHeaders })).status, 404);
    const guestShareToken = (await guestShare.json() as { token: string }).token;
    assert.equal((await fetch(`${baseUrl}/api/share/${guestShareToken}`)).status, 200);
  } finally {
    await closeGateway(server);
    await closeStateDatabases();
    if (previousHome === undefined) delete process.env.TAIWEI_HOME;
    else process.env.TAIWEI_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
