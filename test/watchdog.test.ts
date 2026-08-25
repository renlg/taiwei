import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaiweiApp } from '../src/app.js';
import type { CronJob } from '../src/cron/jobs.js';
import { CronJobStore } from '../src/cron/jobs.js';
import { CronScheduler } from '../src/cron/scheduler.js';
import { PolicyEngine } from '../src/security/policy.js';
import { createWatchdogTools } from '../src/tools/impl/watchdog.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function withHome(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-watchdog-test-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); }
  finally {
    if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('watchdog register creates and idempotently updates a second-level script job, then remove deletes it', async () => withHome(async (directory) => {
  const store = new CronJobStore();
  const scheduler = new CronScheduler(store, async () => ({}));
  const registry = new ToolRegistry();
  for (const tool of createWatchdogTools(store, scheduler)) registry.register(tool);
  const context = { cwd: directory, workspaceRoot: directory, role: 'admin' as const, sessionId: 'admin' };

  const created = JSON.parse(await registry.dispatch('watchdog_register', {
    name: 'gateway-8688', script: 'curl -fsS http://127.0.0.1:8688/api/health >/dev/null', interval_seconds: 15,
  }, context)) as { id: string; schedule: string; nextRun: string };
  assert.equal(created.schedule, 'every 15s');
  assert.ok(Date.parse(created.nextRun) > Date.now());
  let jobs = await store.list();
  assert.equal(jobs.length, 1); assert.equal(jobs[0]?.kind, 'script'); assert.equal(jobs[0]?.timeout, 30_000);

  const updated = JSON.parse(await registry.dispatch('watchdog_register', {
    name: 'gateway-8688', script: 'test -f healthy', interval_seconds: 7, timeout_seconds: 4, enabled: false,
  }, context)) as { id: string; schedule: string; enabled: boolean; nextRun: null };
  assert.equal(updated.id, created.id); assert.equal(updated.schedule, 'every 7s'); assert.equal(updated.enabled, false); assert.equal(updated.nextRun, null);
  jobs = await store.list();
  assert.equal(jobs.length, 1); assert.equal(jobs[0]?.script, 'test -f healthy'); assert.equal(jobs[0]?.timeout, 4_000);

  const removed = JSON.parse(await registry.dispatch('watchdog_remove', { name: 'gateway-8688' }, context)) as { removed: boolean };
  assert.equal(removed.removed, true); assert.deepEqual(await store.list(), []);
  scheduler.stop();
}));

test('guest policy explicitly denies every watchdog tool', () => {
  const policy = new PolicyEngine();
  for (const tool of ['watchdog_register', 'watchdog_list', 'watchdog_remove', 'watchdog_status']) {
    const decision = policy.decide({
      role: 'guest', agentMode: 'build', sessionId: 'guest', tool, args: {}, cwd: '/tmp/guest', workspaceRoot: '/tmp/guest', identity: 'guest',
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.rule, 'builtin.guest.no-watchdog-management');
  }
});

test('TaiweiApp registers watchdog tools and executes script cron jobs', async () => withHome(async () => {
  const app = new TaiweiApp();
  await app.initialize({ external: false, scheduler: false });
  try {
    for (const name of ['watchdog_register', 'watchdog_list', 'watchdog_remove', 'watchdog_status']) {
      assert.ok(app.registry.get(name), `${name} should be registered`);
    }
    const job: CronJob = {
      id: 'script-test', name: 'script-test', schedule: '1h', kind: 'script', script: 'printf healthy',
      timezone: 'local', timeout: 1_000, enabled: true, overlapPolicy: 'skip', misfirePolicy: 'skip',
      delivery: { type: 'none' }, retries: 0, retryDelay: 0,
    };
    const result = await (app as unknown as { executeCron(job: CronJob, signal: AbortSignal): Promise<{ output?: string; exitCode?: number; silent?: boolean }> })
      .executeCron(job, new AbortController().signal);
    assert.deepEqual(result, { output: 'healthy', exitCode: 0, silent: false });
  } finally {
    await app.close();
  }
}));
