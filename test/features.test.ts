import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { CronJobStore } from '../src/cron/jobs.js';
import { CronRunLedger } from '../src/cron/runs.js';
import { CronScheduler } from '../src/cron/scheduler.js';
import { getAgentProfile } from '../src/agents/profiles.js';
import { DelegationManager } from '../src/agent/delegation.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { BrowserToolRuntime } from '../src/tools/impl/browser.js';
import { MemoryStore } from '../src/memory/store.js';
import { createDelegateTool } from '../src/tools/impl/delegate.js';
import { AgentContext } from '../src/agent/context.js';
import { SkillLoader } from '../src/skills/loader.js';
import { PolicyEngine } from '../src/security/policy.js';

async function withHome(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-feature-test-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); }
  finally { if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous; await rm(directory, { recursive: true, force: true }); }
}

test('durable scheduler fires intervals, run-now persists, and restart reloads the ledger', async () => withHome(async (directory) => {
  const store = new CronJobStore();
  const job = await store.add({ name: 'fast', schedule: '20ms', kind: 'script', script: 'ignored', retries: 0, delivery: { type: 'none' } });
  let calls = 0;
  const scheduler = new CronScheduler(store, async () => { calls += 1; return { output: 'ok' }; });
  await scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 65));
  scheduler.stop();
  assert.ok(calls >= 1);
  const manual = await scheduler.runNow(job.id);
  assert.equal(manual.status, 'ok');
  assert.equal((await stat(join(directory, 'state.db'))).isFile(), true);
  const restarted = new CronRunLedger(); await restarted.initialize();
  assert.ok((await restarted.list(job.id)).length >= 2);
}));

test('scheduler honors one-shot misfires and overlap skip', async () => withHome(async () => {
  const store = new CronJobStore();
  const skipped = await store.add({ name: 'old-skip', at: new Date(Date.now() - 1_000).toISOString(), kind: 'script', script: 'x', misfirePolicy: 'skip', retries: 0 });
  const run = await store.add({ name: 'old-run', at: new Date(Date.now() - 1_000).toISOString(), kind: 'script', script: 'x', misfirePolicy: 'run', retries: 0 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new CronScheduler(store, async (job) => { if (job.id === run.id) return { output: 'misfire' }; await gate; return {}; });
  await scheduler.start(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(scheduler.ledger.lastRuns(skipped.id)[0]?.status, 'skipped');
  assert.equal(scheduler.ledger.lastRuns(run.id)[0]?.status, 'ok');
  const overlapJob = await store.add({ name: 'overlap', schedule: '1h', kind: 'script', script: 'x', overlapPolicy: 'skip', retries: 0 });
  const first = scheduler.runNow(overlapJob.id); await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await scheduler.runNow(overlapJob.id); assert.equal(second.status, 'skipped'); release(); await first; scheduler.stop();
}));

test('plan profile denies write tools at listing and dispatch boundaries', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'write_file', description: 'write', parameters: { type: 'object' }, execute: () => 'wrote' });
  registry.register({ name: 'read_file', description: 'read', parameters: { type: 'object' }, execute: () => 'read' });
  const plan = getAgentProfile('plan');
  assert.deepEqual(registry.list({ profile: plan }).map((tool) => tool.name), ['read_file']);
  assert.match(await registry.dispatch('write_file', {}, { cwd: process.cwd(), agentProfile: plan }), /denied by policy/);
});

test('delegation enforces isolation contract, depth, cancellation, and parallel cap', async () => {
  let seen: unknown;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new DelegationManager(async (request) => { seen = request; await gate; if (request.signal.aborted) throw new DOMException('cancelled', 'AbortError'); return 'summary'; }, 1, 2);
  const parent = new AbortController();
  const restrictions = { role: 'guest' as const, identity: 'guest-alice', workspaceRoot: '/tmp/guest-alice', memory: new MemoryStore('/tmp/guest-alice-memory.md'), extendedMemory: false };
  const first = manager.delegate({ task: 'isolated task', profile: getAgentProfile('build'), parentProfile: getAgentProfile('build'), parentSessionId: 'parent', depth: 0, signal: parent.signal, ...restrictions });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(manager.delegate({ task: 'second', profile: getAgentProfile('build'), parentProfile: getAgentProfile('build'), depth: 0, ...restrictions }), /parallel limit/);
  parent.abort(); release(); await assert.rejects(first, /cancelled/);
  assert.equal((seen as { task: string }).task, 'isolated task');
  assert.equal((seen as { role: string }).role, 'guest');
  assert.equal((seen as { identity: string }).identity, 'guest-alice');
  assert.equal((seen as { workspaceRoot: string }).workspaceRoot, '/tmp/guest-alice');
  assert.equal((seen as { memory: MemoryStore }).memory, restrictions.memory);
  assert.equal((seen as { extendedMemory: boolean }).extendedMemory, false);
  assert.equal('history' in (seen as object), false);
  await assert.rejects(manager.delegate({ task: 'deep', profile: getAgentProfile('build'), parentProfile: getAgentProfile('build'), depth: 2, ...restrictions }), /depth limit/);
});

test('delegate tool forwards the caller security and memory scope unchanged', async () => {
  let seen: Parameters<ConstructorParameters<typeof DelegationManager>[0]>[0] | undefined;
  const manager = new DelegationManager(async (request) => { seen = request; return 'done'; });
  const registry = new ToolRegistry();
  registry.register(createDelegateTool(manager));
  const memory = new MemoryStore('/tmp/taiwei-delegate-guest-memory.md');
  const agentContext = new AgentContext(memory, new SkillLoader(), false, getAgentProfile('build'));
  const policy = new PolicyEngine({ rules: [{ match: { role: 'guest', tool: 'delegate_task' }, effect: 'allow' }] });
  const output = JSON.parse(await registry.dispatch('delegate_task', { task: 'safe child' }, {
    cwd: '/tmp/guest-workspace', workspaceRoot: '/tmp/guest-workspace', role: 'guest', identity: 'guest-alice',
    sessionId: 'parent', agentContext, agentProfile: getAgentProfile('build'), policy,
  })) as { result: string };
  assert.equal(output.result, 'done');
  assert.equal(seen?.role, 'guest');
  assert.equal(seen?.identity, 'guest-alice');
  assert.equal(seen?.workspaceRoot, '/tmp/guest-workspace');
  assert.equal(seen?.memory, memory);
  assert.equal(seen?.extendedMemory, false);
});

test('browser tools validate arguments and explain missing Chromium', async () => {
  const runtime = new BrowserToolRuntime(async () => { throw new Error('executable does not exist'); });
  const registry = new ToolRegistry(); for (const tool of runtime.tools()) registry.register(tool);
  assert.match(await registry.dispatch('browser_navigate', { url: 'file:///tmp/a' }, { cwd: process.cwd() }), /http or https/);
  assert.match(await registry.dispatch('browser_click', { selector: '' }, { cwd: process.cwd() }), /selector must be a non-empty string/);
  assert.match(await registry.dispatch('browser_navigate', { url: 'https://example.com' }, { cwd: process.cwd() }), /npx playwright install chromium/);
  await runtime.close();
});

test('real browser smoke', { skip: process.env.TAIWEI_REAL_BROWSER !== '1' }, async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Browser smoke</title><main>ready</main>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test port');
  const runtime = new BrowserToolRuntime(); const registry = new ToolRegistry(); for (const tool of runtime.tools()) registry.register(tool);
  try {
    const result = JSON.parse(await registry.dispatch('browser_navigate', { url: `http://127.0.0.1:${address.port}` }, { cwd: process.cwd() }));
    assert.equal(result.title, 'Browser smoke'); assert.match(result.text, /ready/);
  } finally { await runtime.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
