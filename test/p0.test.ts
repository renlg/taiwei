import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionRuntime } from '../src/agent/runtime.js';
import { applyContextBudget } from '../src/agent/budget.js';
import { PolicyEngine } from '../src/security/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { getAgentProfile } from '../src/agents/profiles.js';
import { resolveInWorkspace } from '../src/util/paths.js';
import { appendAudit } from '../src/observability/audit.js';
import { streamChat, type ChatMessage } from '../src/llm/client.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { AgentContext } from '../src/agent/context.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import type { ChatBridge } from '../src/gateway/chat.js';

async function temporaryHome(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-p0-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); }
  finally { if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous; await rm(directory, { recursive: true, force: true }); }
}

async function provider(handler: (requestBody: Record<string, unknown>, count: number) => { status?: number; headers?: Record<string, string>; body?: unknown }, run: (baseUrl: string, calls: () => number) => Promise<void>): Promise<void> {
  let count = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const answer = handler(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, ++count);
    response.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers });
    response.end(JSON.stringify(answer.body ?? { choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  try { await run(`http://127.0.0.1:${address.port}/v1`, () => count); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('policy denies guest shell/write escapes and plan writes while custom rules override defaults', async () => temporaryHome(async (directory) => {
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  const registry = new ToolRegistry();
  registry.register({ name: 'bash', description: 'shell', parameters: { type: 'object' }, execute: () => 'ran' });
  registry.register({ name: 'write_file', description: 'write', parameters: { type: 'object' }, execute: () => 'wrote' });
  assert.match(await registry.dispatch('bash', { command: 'rm -rf /tmp/x' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /denied by policy/);
  assert.match(await registry.dispatch('write_file', { path: '../secret', content: 'x' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /denied by policy/);
  assert.match(await registry.dispatch('write_file', { path: 'x' }, { cwd: workspace, workspaceRoot: workspace, agentProfile: getAgentProfile('plan'), sessionId: 'p' }), /builtin\.plan\.read-only/);
  const allow = new PolicyEngine({ rules: [{ match: { role: 'guest', tool: 'mcp_safe_*' }, effect: 'allow' }] });
  assert.equal(allow.decide({ role: 'guest', agentMode: 'build', sessionId: 'g', tool: 'mcp_safe_read', args: {}, cwd: workspace, workspaceRoot: workspace, identity: 'g' }).effect, 'allow');
  const deny = new PolicyEngine({ rules: [{ match: { role: 'admin', tool: 'read_file' }, effect: 'deny' }] });
  assert.equal(deny.decide({ role: 'admin', agentMode: 'build', sessionId: 'a', tool: 'read_file', args: {}, cwd: workspace, workspaceRoot: workspace, identity: 'a' }).effect, 'deny');
}));

test('workspace resolver rejects traversal and symlink escapes for existing and new targets', async () => temporaryHome(async (directory) => {
  const workspace = join(directory, 'workspace'); const outside = join(directory, 'outside');
  await mkdir(workspace); await mkdir(outside); await writeFile(join(outside, 'secret'), 'secret'); await symlink(outside, join(workspace, 'link'));
  await assert.rejects(resolveInWorkspace('../outside/secret', workspace), /escapes workspace/);
  await assert.rejects(resolveInWorkspace('link/new-file', workspace), /escapes workspace/);
  assert.match(await resolveInWorkspace('new/sub/file', workspace), /\/workspace\/new\/sub\/file$/);
}));

test('session runtime isolates cancellation and enforces the global concurrency cap', async () => {
  const runtime = new SessionRuntime(2);
  const cancelled = runtime.run('A', (signal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })));
  const completed = runtime.run('B', async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return 'B done'; });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(runtime.stop('A'), true);
  await assert.rejects(cancelled, /cancelled/); assert.equal(await completed, 'B done');

  const capped = new SessionRuntime(1); let active = 0; let peak = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = capped.run('one', async () => { active += 1; peak = Math.max(peak, active); await gate; active -= 1; });
  const second = capped.run('two', async () => { active += 1; peak = Math.max(peak, active); active -= 1; });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(capped.activeTurns, 1); assert.equal(capped.controller('two').queue, 1);
  release(); await Promise.all([first, second]); assert.equal(peak, 1);
});

test('context budget prunes tool results and reserves output capacity', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: 'x'.repeat(800) },
  ];
  const result = applyContextBudget(messages, 'system', [], 100, { systemMax: 20, historyMax: 90, toolsMax: 20, outputReserve: 40 }, 4);
  assert.ok(result.prunedChars > 0); assert.match((messages[2] as { content: string }).content, /^\[truncated 800 chars]/);
  assert.ok(result.estimatedTokens <= 100 - 40 || result.needsCompression);
});

test('estimate-based compression runs when provider omits usage', async () => temporaryHome(async () => {
  await provider(() => ({ body: { choices: [{ message: { content: 'summary' } }] } }), async (baseUrl, calls) => {
    const context = new AgentContext(new MemoryStore(), new SkillLoader());
    const history: ChatMessage[] = [];
    for (let index = 0; index < 30; index += 1) { history.push({ role: 'user', content: `old ${index} ${'x'.repeat(40)}` }, { role: 'assistant', content: `answer ${index}` }); }
    context.setMessages(history);
    const config = { ...structuredClone(DEFAULT_CONFIG), baseUrl, model: 'primary', contextWindow: 300, compressThreshold: 0.5, memoryFlush: false, budget: { systemMax: 30, historyMax: 250, toolsMax: 20, outputReserve: 50 } };
    await runAgentTurn('new prompt', context, new ToolRegistry(), config, { retainConversation: true });
    assert.ok(calls() >= 2); assert.match(JSON.stringify(context.messages), /Conversation summary/);
  });
}));

test('provider retries 429/5xx, fast-fails 401, honors Retry-After, and uses fallback model', async () => {
  await provider((_body, count) => count === 1
    ? { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'slow down' } } }
    : { body: { choices: [{ message: { content: 'recovered' } }] } }, async (baseUrl, calls) => {
    const delays: number[] = [];
    const result = await streamChat({ baseUrl, apiKey: '', model: 'primary', messages: [], tools: [], retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, sleep: async (ms) => { delays.push(ms); }, random: () => 0 } });
    assert.equal(result.content, 'recovered'); assert.equal(calls(), 2); assert.deepEqual(delays, [2000]);
  });
  await provider((_body, count) => count === 1 ? { status: 503, body: { error: { message: 'down' } } } : { body: { choices: [{ message: { content: 'ok' } }] } }, async (baseUrl, calls) => {
    assert.equal((await streamChat({ baseUrl, apiKey: '', model: 'm', messages: [], tools: [], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} } })).content, 'ok');
    assert.equal(calls(), 2);
  });
  await provider(() => ({ status: 401, body: { error: { message: 'bad key' } } }), async (baseUrl, calls) => {
    await assert.rejects(streamChat({ baseUrl, apiKey: '', model: 'm', fallbackModel: 'fallback', messages: [], tools: [], retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} } }), /401/);
    assert.equal(calls(), 1);
  });
  const models: string[] = [];
  await provider((body) => { const model = String(body.model); models.push(model); return model === 'fallback' ? { body: { choices: [{ message: { content: 'fallback ok' } }] } } : { status: 500, body: { error: { message: 'no' } } }; }, async (baseUrl) => {
    const result = await streamChat({ baseUrl, apiKey: '', model: 'primary', fallbackModel: 'fallback', messages: [], tools: [], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} } });
    assert.equal(result.content, 'fallback ok'); assert.deepEqual(models, ['primary', 'primary', 'fallback']);
  });
});

test('audit recursively redacts secret-shaped argument keys', async () => temporaryHome(async (directory) => {
  await appendAudit({ type: 'tool.call', runId: 'r', sessionId: 's', tool: 'demo', outcome: 'success', args: { apiKey: 'never-log-me', nested: { access_token: 'also-secret', safe: 'visible' } } });
  const content = await readFile(join(directory, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(content, /never-log-me|also-secret/); assert.match(content, /"apiKey":"\*\*\*"/); assert.match(content, /visible/);
}));

test('gateway audit API is authenticated and administrator-only', async () => temporaryHome(async (directory) => {
  await appendAudit({ type: 'turn.start', runId: 'r', sessionId: 's', outcome: 'started' });
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const admin = await authSessions.create('admin', 'admin'); const guest = await authSessions.create('guest', 'guest');
  const chat: ChatBridge = { run: async () => {}, stop: () => false };
  const server = createGatewayServer({ chat, auth: { enabled: true, username: 'admin', password: 'password' }, authSessions, log: () => {} });
  const port = await listenGateway(server, '127.0.0.1', 0); const url = `http://127.0.0.1:${port}/api/audit`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${guest}` } })).status, 403);
    const response = await fetch(url, { headers: { authorization: `Bearer ${admin}` } });
    assert.equal(response.status, 200); assert.equal(((await response.json()) as { entries: unknown[] }).entries.length, 1);
  } finally { await closeGateway(server); }
}));
