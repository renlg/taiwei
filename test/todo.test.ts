import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readTodos, todoTools, type TodoItem } from '../src/tools/impl/todo.js';
import { ToolRegistry, type ToolContext } from '../src/tools/registry.js';

interface TodoResult { ok: boolean; sessionId: string; todos: TodoItem[]; summary: { total: number; complete: number; inProgress: number; pending: number; cancelled: number } }

const todoWrite = todoTools.find((tool) => tool.name === 'todo_write')!;
const todoRead = todoTools.find((tool) => tool.name === 'todo_read')!;

async function withHome<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-todo-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { return await run(directory); }
  finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
}

const call = async (tool: typeof todoWrite, args: Record<string, unknown>, context: ToolContext): Promise<TodoResult> =>
  await tool.execute(args, context) as TodoResult;

test('todo_write creates a checklist, assigns ids, persists per session, and summarizes', async () => {
  await withHome(async (directory) => {
    const context: ToolContext = { cwd: directory, sessionId: 'session-a' };
    const result = await call(todoWrite, { todos: [
      { content: '第一步', status: 'complete' },
      { content: '第二步', status: 'in_progress' },
      { content: '第三步' },
    ] }, context);
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'session-a');
    assert.deepEqual(result.todos.map((item) => item.id), ['t1', 't2', 't3']);
    assert.deepEqual(result.todos.map((item) => item.status), ['complete', 'in_progress', 'pending']);
    assert.deepEqual(result.summary, { total: 3, complete: 1, inProgress: 1, pending: 1, cancelled: 0 });

    // Persisted to disk and re-readable.
    assert.equal((await readTodos('session-a')).length, 3);
    const readBack = await call(todoRead, {}, context);
    assert.deepEqual(readBack.todos.map((item) => item.content), ['第一步', '第二步', '第三步']);

    // A different session starts empty (per-session isolation).
    assert.deepEqual(await readTodos('session-b'), []);
  });
});

test('todo_write merge:false replaces the list, merge:true updates by id and appends new items', async () => {
  await withHome(async (directory) => {
    const context: ToolContext = { cwd: directory, sessionId: 'merge-session' };
    await call(todoWrite, { todos: [
      { id: 'a', content: 'task a', status: 'pending' },
      { id: 'b', content: 'task b', status: 'pending' },
    ] }, context);

    // merge:true — update "a", keep "b", append "c"; original order preserved.
    const merged = await call(todoWrite, { merge: true, todos: [
      { id: 'a', content: 'task a', status: 'complete' },
      { id: 'c', content: 'task c', status: 'in_progress' },
    ] }, context);
    assert.deepEqual(merged.todos.map((item) => item.id), ['a', 'b', 'c']);
    assert.deepEqual(merged.todos.map((item) => item.status), ['complete', 'pending', 'in_progress']);

    // merge:false (default) — the previous list is discarded entirely.
    const replaced = await call(todoWrite, { todos: [{ id: 'z', content: 'only task', status: 'pending' }] }, context);
    assert.deepEqual(replaced.todos.map((item) => item.id), ['z']);
    assert.equal(replaced.summary.total, 1);
  });
});

test('todo_write rejects malformed input and coerces an unknown status to pending', async () => {
  await withHome(async (directory) => {
    const context: ToolContext = { cwd: directory, sessionId: 'invalid' };
    await assert.rejects(call(todoWrite, { todos: 'not-an-array' as unknown as [] }, context), /todos must be an array/);
    await assert.rejects(call(todoWrite, { todos: [{ content: '   ' }] }, context), /content must be a non-empty string/);
    // An unrecognized status is coerced to 'pending' rather than rejected.
    const coerced = await call(todoWrite, { todos: [{ content: 'ok', status: 'bogus' }] }, context);
    assert.equal(coerced.todos[0]?.status, 'pending');
  });
});

test('guest sessions may use todo_write through the policy engine', async () => {
  await withHome(async (directory) => {
    const registry = new ToolRegistry();
    for (const tool of todoTools) registry.register(tool);
    const context: ToolContext = { cwd: directory, workspaceRoot: directory, role: 'guest', sessionId: 'guest-1' };
    const output = JSON.parse(await registry.dispatch('todo_write', { todos: [{ content: 'guest step', status: 'in_progress' }] }, context)) as TodoResult;
    assert.equal(output.ok, true);
    assert.equal(output.summary.total, 1);
  });
});
