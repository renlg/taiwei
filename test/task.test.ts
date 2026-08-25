import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PolicyEngine } from '../src/security/policy.js';
import { taskTools } from '../src/tools/impl/task.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function withHome(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-task-test-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); }
  finally {
    if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function adminContext(directory: string) {
  return { cwd: directory, workspaceRoot: directory, role: 'admin' as const, sessionId: 'admin' };
}

test('task_start + task_wait: short command returns completed with correct stdout and exitCode', async () => withHome(async (directory) => {
  const registry = new ToolRegistry();
  for (const tool of taskTools) registry.register(tool);
  const context = adminContext(directory);

  const startResult = JSON.parse(await registry.dispatch('task_start', { command: 'echo "hello world"' }, context)) as { id: string; pid: number };
  assert.ok(startResult.id);
  assert.ok(startResult.pid > 0);

  const waitResult = JSON.parse(await registry.dispatch('task_wait', { id: startResult.id, timeout_seconds: 10 }, context)) as {
    id: string; status: string; stdout: string; exitCode: number | null;
  };
  assert.equal(waitResult.status, 'completed');
  assert.equal(waitResult.stdout.trim(), 'hello world');
  assert.equal(waitResult.exitCode, 0);
}));

test('task_wait: failed command (exit 1) returns exitCode 1', async () => withHome(async (directory) => {
  const registry = new ToolRegistry();
  for (const tool of taskTools) registry.register(tool);
  const context = adminContext(directory);

  const startResult = JSON.parse(await registry.dispatch('task_start', { command: 'exit 1' }, context)) as { id: string };

  const waitResult = JSON.parse(await registry.dispatch('task_wait', { id: startResult.id, timeout_seconds: 10 }, context)) as {
    status: string; exitCode: number | null;
  };
  assert.equal(waitResult.status, 'completed');
  assert.equal(waitResult.exitCode, 1);
}));

test('task_poll: running task shows running status', async () => withHome(async (directory) => {
  const registry = new ToolRegistry();
  for (const tool of taskTools) registry.register(tool);
  const context = adminContext(directory);

  const startResult = JSON.parse(await registry.dispatch('task_start', { command: 'sleep 30' }, context)) as { id: string };

  try {
    const pollResult = JSON.parse(await registry.dispatch('task_poll', { id: startResult.id }, context)) as {
      status: string; pid: number;
    };
    assert.equal(pollResult.status, 'running');
    assert.ok(pollResult.pid > 0);
  } finally {
    await registry.dispatch('task_kill', { id: startResult.id }, context);
  }
}));

test('task_wait: timeout returns timed_out with partial output, task keeps running, then kill works', async () => withHome(async (directory) => {
  const registry = new ToolRegistry();
  for (const tool of taskTools) registry.register(tool);
  const context = adminContext(directory);

  const startResult = JSON.parse(await registry.dispatch('task_start', {
    command: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; sleep 1; done',
  }, context)) as { id: string };

  const waitResult = JSON.parse(await registry.dispatch('task_wait', { id: startResult.id, timeout_seconds: 2 }, context)) as {
    status: string; stdout: string;
  };
  assert.equal(waitResult.status, 'timed_out');

  const pollAfterWait = JSON.parse(await registry.dispatch('task_poll', { id: startResult.id }, context)) as {
    status: string;
  };
  assert.equal(pollAfterWait.status, 'running');

  const killResult = JSON.parse(await registry.dispatch('task_kill', { id: startResult.id }, context)) as {
    status: string; killed: boolean;
  };
  assert.equal(killResult.status, 'killed');
  assert.equal(killResult.killed, true);
}));

test('task_kill: killing an already-finished task is a no-op', async () => withHome(async (directory) => {
  const registry = new ToolRegistry();
  for (const tool of taskTools) registry.register(tool);
  const context = adminContext(directory);

  const startResult = JSON.parse(await registry.dispatch('task_start', { command: 'echo done' }, context)) as { id: string };
  await registry.dispatch('task_wait', { id: startResult.id, timeout_seconds: 10 }, context);

  const killResult = JSON.parse(await registry.dispatch('task_kill', { id: startResult.id }, context)) as {
    status: string; killed: boolean;
  };
  assert.equal(killResult.killed, false);
}));

test('guest policy denies all task_* tools', () => {
  const policy = new PolicyEngine();
  for (const tool of ['task_start', 'task_wait', 'task_poll', 'task_kill']) {
    const decision = policy.decide({
      role: 'guest', agentMode: 'build', sessionId: 'guest', tool, args: {}, cwd: '/tmp/guest', workspaceRoot: '/tmp/guest', identity: 'guest',
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.rule, 'builtin.guest.no-task-management');
  }
});

test('plan mode denies task_start and task_kill but allows task_poll and task_wait', () => {
  const policy = new PolicyEngine();
  for (const tool of ['task_start', 'task_kill']) {
    const decision = policy.decide({
      role: 'admin', agentMode: 'plan', sessionId: 'admin', tool, args: {}, cwd: '/tmp', workspaceRoot: '/tmp', identity: 'admin',
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.rule, 'builtin.plan.read-only');
  }
  for (const tool of ['task_poll', 'task_wait']) {
    const decision = policy.decide({
      role: 'admin', agentMode: 'plan', sessionId: 'admin', tool, args: {}, cwd: '/tmp', workspaceRoot: '/tmp', identity: 'admin',
    });
    assert.equal(decision.effect, 'allow');
  }
});
