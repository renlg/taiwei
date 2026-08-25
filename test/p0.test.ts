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
import { bashTool, constrainGuestBash, createBashTool } from '../src/tools/impl/bash.js';
import { writeTool } from '../src/tools/impl/write.js';
import { readTool } from '../src/tools/impl/read.js';
import { getAgentProfile } from '../src/agents/profiles.js';
import { resolveInWorkspace } from '../src/util/paths.js';
import { appendAudit } from '../src/observability/audit.js';
import { streamChat, type ChatMessage } from '../src/llm/client.js';
import { ProviderHttpError, retryableProviderError } from '../src/llm/retry.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { AgentContext } from '../src/agent/context.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { runAgentTurn, type AgentEvent } from '../src/agent/loop.js';
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

test('policy allows guest workspace writes, rejects write escapes, and keeps shell and plan writes denied', async () => temporaryHome(async (directory) => {
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  const registry = new ToolRegistry();
  registry.register({ name: 'bash', description: 'shell', parameters: { type: 'object' }, execute: () => 'ran' });
  registry.register(writeTool);
  // guest bash 默认放行（jailed-bash，不再被 policy deny）；越权拦截由 bash 工具内部 constrainGuestBash 负责（见 81 行测试）
  assert.doesNotMatch(await registry.dispatch('bash', { command: 'rm -rf /tmp/x' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /denied by policy/);
  const allowedWrite = new PolicyEngine().decide({ role: 'guest', agentMode: 'build', sessionId: 'g', tool: 'write_file', args: { path: 'inside.txt' }, cwd: workspace, workspaceRoot: workspace, identity: 'g' });
  assert.deepEqual(allowedWrite, { effect: 'allow', rule: 'builtin.guest.workspace-write', explicit: false });
  assert.match(await registry.dispatch('write_file', { path: 'inside.txt', content: 'guest data' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /"ok":true/);
  assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'guest data');
  assert.match(await registry.dispatch('write_file', { path: '../secret', content: 'x' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /Path escapes workspace/);
  assert.match(await registry.dispatch('write_file', { path: '/etc/taiwei-test', content: 'x' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /Path escapes workspace/);
  assert.match(await registry.dispatch('write_file', { path: 'x' }, { cwd: workspace, workspaceRoot: workspace, agentProfile: getAgentProfile('plan'), sessionId: 'p' }), /builtin\.plan\.read-only/);
  registry.register({ name: 'delegate_task', description: 'delegate', parameters: { type: 'object' }, execute: () => 'delegated' });
  assert.match(await registry.dispatch('delegate_task', { task: 'escape' }, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /builtin\.guest\.no-delegation/);
  registry.register({ name: 'future_sensitive_tool', description: 'future', parameters: { type: 'object' }, execute: () => 'unsafe' });
  assert.match(await registry.dispatch('future_sensitive_tool', {}, { cwd: workspace, workspaceRoot: workspace, role: 'guest', sessionId: 'g' }), /builtin\.guest\.default-deny/);
  assert.equal(new PolicyEngine().decide({ role: 'guest', agentMode: 'build', sessionId: 'g', tool: 'read_file', args: {}, cwd: workspace, workspaceRoot: workspace, identity: 'g' }).effect, 'allow');
  assert.equal(new PolicyEngine().decide({ role: 'guest', agentMode: 'build', sessionId: 'g', tool: 'load_skill', args: { name: 'example' }, cwd: workspace, workspaceRoot: workspace, identity: 'g' }).effect, 'allow');
  assert.equal(new PolicyEngine().decide({ role: 'admin', agentMode: 'plan', sessionId: 'p', tool: 'delegate_task', args: {}, cwd: workspace, workspaceRoot: workspace, identity: 'admin' }).effect, 'deny');
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

test('guest bash stays inside its workspace while admin bash remains unrestricted', async () => temporaryHome(async (directory) => {
  const workspace = join(directory, 'guest-workspace');
  const outside = join(directory, 'outside');
  await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, 'inside.txt'), 'inside');
  const registry = new ToolRegistry(); registry.register(createBashTool({
    lookupOsUser: async () => 'guest1', lookupGiteaToken: async () => 'guest-token', isRoot: () => true,
    executeFile: async () => ({ stdout: 'inside.txt\n', stderr: '' }),
  }));
  const guestPolicy = new PolicyEngine({ rules: [{ match: { role: 'guest', tool: 'bash' }, effect: 'allow' }] });
  const guest = (command: string, cwd = workspace) => registry.dispatch('bash', { command }, {
    cwd, workspaceRoot: workspace, role: 'guest', identity: 'alice', sessionId: 'guest-bash', policy: guestPolicy,
  });

  assert.match(await guest('cat /etc/passwd'), /guest .*\u53ea\u80fd\u64cd\u4f5c\u81ea\u5df1\u7684\u5de5\u4f5c\u76ee\u5f55/);
  assert.match(await guest('cd /root && ls'), /路径越界/);
  assert.match(await guest('rm -rf ~'), /路径越界/);
  assert.match(await guest('sudo whoami'), /禁止系统级命令/);
  const inside = JSON.parse(await guest(`ls ${workspace}`)) as { stdout?: string; error?: string };
  assert.equal(inside.error, undefined); assert.match(inside.stdout ?? '', /inside\.txt/);
  assert.match(await guest('ls', outside), /workspace-boundary/);

  const adminRegistry = new ToolRegistry(); adminRegistry.register(bashTool);
  const admin = JSON.parse(await adminRegistry.dispatch('bash', { command: 'cat /etc/passwd' }, {
    cwd: workspace, workspaceRoot: workspace, role: 'admin', sessionId: 'admin-bash',
  })) as { stdout?: string; error?: string };
  assert.equal(admin.error, undefined); assert.match(admin.stdout ?? '', /root:/);
}));

test('guest bash allows scripts only from the explicitly configured guest skill directory', async () => temporaryHome(async (directory) => {
  const workspace = join(directory, 'workspace');
  const guestSkillDir = '/home/guest-demo/.taiwei/skills';
  const script = '/home/guest-demo/.taiwei/skills/x.sh';
  await mkdir(workspace, { recursive: true });

  assert.equal(await constrainGuestBash(`bash ${script}`, workspace, workspace, guestSkillDir), undefined);
  assert.equal(await constrainGuestBash('bash ~/.taiwei/skills/x.sh', workspace, workspace, guestSkillDir), undefined);
  assert.match((await constrainGuestBash(`bash ${script}`, workspace, workspace))?.error ?? '', /路径越界/);
}));

test('guest helper scripts cannot push to foreign Gitea owners and own pushes use context identity', async () => temporaryHome(async (directory) => {
  const foreign = join(directory, 'foreign.sh');
  const own = join(directory, 'own.sh');
  await writeFile(foreign, '#!/bin/bash\ngit push http://admin:stolen@127.0.0.1:3000/admin/private-commerce.git main\n');
  await writeFile(own, '#!/bin/bash\ngit push http://127.0.0.1:3000/guest1/private-commerce.git main\n');
  const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const tool = createBashTool({
    lookupOsUser: async (identity) => identity === 'alice' ? 'guest1' : undefined,
    lookupGiteaToken: async (identity) => identity === 'alice' ? 'guest-token' : undefined,
    isRoot: () => true,
    executeFile: async (file, args, options) => { calls.push({ file, args, env: options.env }); return { stdout: 'ok', stderr: '' }; },
  });
  const context = { cwd: directory, workspaceRoot: directory, role: 'guest' as const, identity: 'alice' };
  const denied = await tool.execute({ command: 'bash foreign.sh' }, context) as { error?: string };
  assert.match(denied.error ?? '', /remote.*token|其他账号|远程地址/);
  assert.equal(calls.length, 0);
  const allowed = await tool.execute({ command: 'bash own.sh' }, context) as { error?: string };
  assert.equal(allowed.error, undefined);
  assert.equal(calls[0]?.file, 'runuser');
  assert.equal(calls[0]?.env?.USER, 'guest1');
  assert.equal(calls[0]?.env?.TAIWEI_GITEA_TOKEN, 'guest-token');
}));

test('guest reads and helper scripts deny administrator credential files and redact token output', async () => temporaryHome(async (directory) => {
  const sensitive = join(directory, '.env.gitea');
  await writeFile(sensitive, 'GITEA_API_TOKEN=admin-secret-token\n');
  const registry = new ToolRegistry(); registry.register(readTool);
  const read = await registry.dispatch('read_file', { path: sensitive }, {
    cwd: directory, workspaceRoot: directory, role: 'guest', identity: 'alice', sessionId: 'sensitive-read',
  });
  assert.match(read, /敏感文件/); assert.doesNotMatch(read, /admin-secret-token/);

  await writeFile(join(directory, 'leak.sh'), '#!/bin/bash\ncat .env.gitea\n');
  let executed = false;
  const bash = createBashTool({
    lookupOsUser: async () => 'guest1', isRoot: () => true,
    executeFile: async () => { executed = true; return { stdout: 'Authorization: token admin-secret-token', stderr: '' }; },
  });
  const denied = await bash.execute({ command: 'bash leak.sh' }, { cwd: directory, workspaceRoot: directory, role: 'guest', identity: 'alice' }) as { error?: string };
  assert.match(denied.error ?? '', /管理员凭据/); assert.equal(executed, false);
}));

test('guest bash uses runuser with the mapped tenant account while admin keeps the process shell', async () => temporaryHome(async (directory) => {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const tool = createBashTool({
    lookupOsUser: async (identity) => identity === 'alice' ? 'guest1' : undefined,
    isRoot: () => true,
    executeFile: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      return { stdout: 'ok', stderr: '' };
    },
  });
  await tool.execute({ command: 'pwd' }, { cwd: directory, workspaceRoot: directory, role: 'guest', identity: 'alice' });
  await tool.execute({ command: 'pwd' }, { cwd: directory, workspaceRoot: directory, role: 'admin', identity: 'admin' });
  assert.deepEqual(calls[0], {
      file: 'runuser', args: ['-u', 'guest1', '--preserve-environment', '--', '/bin/bash', '-c', `cd -- "$1" && pwd`, 'guest-bash', directory], cwd: directory,
  });
  assert.equal(calls[1]?.file, process.env.SHELL || '/bin/sh');
}));

test('guest bash strictly prefers the persisted tenant identity and only falls back for legacy sessions', async () => temporaryHome(async (directory) => {
  const executions: Array<{ file: string; args: string[] }> = [];
  const osLookups: string[] = [];
  const tokenLookups: string[] = [];
  const tool = createBashTool({
    lookupOsUser: async (identity) => { osLookups.push(identity); return 'live-db-user'; },
    lookupGiteaToken: async (identity) => { tokenLookups.push(identity); return 'guest-token'; },
    lookupGiteaBaseUrl: async () => 'http://127.0.0.1:3000',
    isRoot: () => true,
    executeFile: async (file, args) => { executions.push({ file, args }); return { stdout: 'ok', stderr: '' }; },
  });
  const base = { cwd: directory, workspaceRoot: directory, role: 'guest' as const, identity: 'alice' };

  const snapshotted = await tool.execute({ command: 'git clone http://127.0.0.1:3000/snapshot-os/repo.git' }, {
    ...base,
    tenantIdentity: { osUsername: 'snapshot-os', giteaUsername: 'snapshot-gitea', giteaOrgName: 'snapshot-org' },
  }) as { error?: string };
  assert.equal(snapshotted.error, undefined);
  assert.deepEqual(osLookups, []);
  assert.deepEqual(tokenLookups, ['snapshot-gitea', 'snapshot-gitea']);
  assert.deepEqual(executions[0]?.args.slice(0, 2), ['-u', 'snapshot-os']);

  const legacy = await tool.execute({ command: 'pwd' }, base) as { error?: string };
  assert.equal(legacy.error, undefined);
  assert.deepEqual(osLookups, ['alice']);
  assert.deepEqual(executions[1]?.args.slice(0, 2), ['-u', 'live-db-user']);

  const emptySnapshot = await tool.execute({ command: 'pwd' }, {
    ...base,
    tenantIdentity: { osUsername: '', giteaUsername: 'snapshot-gitea' },
  }) as { error?: string };
  assert.match(emptySnapshot.error ?? '', /无法解析当前用户的系统账号/);
  assert.deepEqual(osLookups, ['alice']);
  assert.equal(executions.length, 2);
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
    const config = { ...structuredClone(DEFAULT_CONFIG), baseUrl, model: 'primary', contextWindow: 300, compressThreshold: 0.5, memoryFlush: false, skillSelfLearning: false, budget: { systemMax: 30, historyMax: 250, toolsMax: 20, outputReserve: 50 } };
    const agentEvents: AgentEvent[] = [];
    await runAgentTurn('new prompt', context, new ToolRegistry(), config, { retainConversation: true, onEvent: (event) => { agentEvents.push(event); } });
    const usageEvents = agentEvents.filter((event) => event.type === 'usage');
    assert.ok(calls() >= 2); assert.match(JSON.stringify(context.messages), /Conversation summary/);
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0]?.type, 'usage');
    assert.equal(usageEvents[0]?.type === 'usage' && usageEvents[0].compressed, true);
    assert.ok(usageEvents[0]?.type === 'usage' && usageEvents[0].usage.promptTokens > 0);
    const compressingIndex = agentEvents.findIndex((event) => event.type === 'compressing');
    const usageIndex = agentEvents.findIndex((event) => event.type === 'usage');
    assert.ok(compressingIndex >= 0);
    assert.ok(compressingIndex < usageIndex);
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

test('OpenAI-compatible requests default max_tokens and preserve an explicit maxTokens value', async () => {
  const maxTokens: unknown[] = [];
  await provider((body) => {
    maxTokens.push(body.max_tokens);
    return { body: { choices: [{ message: { content: 'ok' } }] } };
  }, async (baseUrl) => {
    await streamChat({ baseUrl, apiKey: '', model: 'default-budget', messages: [], tools: [] });
    await streamChat({ baseUrl, apiKey: '', model: 'custom-budget', maxTokens: 12_345, messages: [], tools: [] });
  });
  assert.deepEqual(maxTokens, [8192, 12_345]);
});

test('provider retry classification includes only transient 400 responses', () => {
  assert.equal(retryableProviderError(new ProviderHttpError(400, 'Upstream service temporarily unavailable')), true);
  assert.equal(retryableProviderError(new ProviderHttpError(400, 'Please try again later')), true);
  assert.equal(retryableProviderError(new ProviderHttpError(400, 'upstream error')), true);
  assert.equal(retryableProviderError(new ProviderHttpError(400, 'invalid request')), false);
  assert.equal(retryableProviderError(new ProviderHttpError(400, 'Bad Request')), false);
  assert.equal(retryableProviderError(new ProviderHttpError(429, 'too many requests')), true);
  assert.equal(retryableProviderError(new ProviderHttpError(500, 'internal server error')), true);
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
