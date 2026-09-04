import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getPaths } from '../../util/paths.js';
import type { ToolSpec } from '../registry.js';

export type TodoStatus = 'pending' | 'in_progress' | 'complete' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  updatedAt: string;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'complete', 'cancelled'];
const MAX_TODOS = 200;
const MAX_CONTENT_CHARS = 400;

function todosDir(): string {
  return join(getPaths().home, 'todos');
}

function sessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'local';
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return join(todosDir(), `${safe}-${digest}.json`);
}

function newId(existing: TodoItem[]): string {
  const taken = new Set(existing.map((item) => item.id));
  let index = existing.length + 1;
  let id = `t${index}`;
  while (taken.has(id)) { index += 1; id = `t${index}`; }
  return id;
}

export async function readTodos(sessionId: string): Promise<TodoItem[]> {
  try {
    const raw = await readFile(sessionFile(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as { todos?: unknown };
    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos.filter((item): item is TodoItem =>
      Boolean(item) && typeof item === 'object'
      && typeof (item as TodoItem).id === 'string'
      && typeof (item as TodoItem).content === 'string'
      && STATUSES.includes((item as TodoItem).status));
  } catch {
    return [];
  }
}

async function writeTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
  await mkdir(todosDir(), { recursive: true });
  await writeFile(sessionFile(sessionId), JSON.stringify({ todos }, null, 2));
}

function normalizeInput(value: unknown, index: number, existing: TodoItem[]): { id: string; content: string; status: TodoStatus } {
  if (!value || typeof value !== 'object') throw new Error(`todo_write: todos[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) throw new Error(`todo_write: todos[${index}].content must be a non-empty string`);
  const status = typeof raw.status === 'string' && (STATUSES as readonly string[]).includes(raw.status)
    ? raw.status as TodoStatus
    : 'pending';
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newId(existing);
  return { id, content: content.slice(0, MAX_CONTENT_CHARS), status };
}

function summarize(todos: TodoItem[]): { total: number; complete: number; inProgress: number; pending: number; cancelled: number } {
  return {
    total: todos.length,
    complete: todos.filter((item) => item.status === 'complete').length,
    inProgress: todos.filter((item) => item.status === 'in_progress').length,
    pending: todos.filter((item) => item.status === 'pending').length,
    cancelled: todos.filter((item) => item.status === 'cancelled').length,
  };
}

export const todoTools: ToolSpec[] = [
  {
    name: 'todo_write',
    description: `Create or update a visible task checklist for the current session. Use this for any non-trivial request that needs three or more distinct steps, or whenever the user gives multiple tasks. The checklist is shown to the user in the UI, so keep it current as work progresses.

Guidelines:
- Break the work into concrete, individually verifiable items.
- Set exactly one item to in_progress at a time — the step you are actively working on.
- Mark items complete as soon as they are done; do not batch status updates at the end.
- Pass the full desired list. With merge:false (default) the list replaces the previous one; with merge:true items are merged by id (existing ids update, new ids append).
- Add a new item when a follow-up task surfaces mid-work; set cancelled for items no longer relevant.`,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The checklist items.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id for merge:true updates. Omit to auto-assign.' },
              content: { type: 'string', description: 'Short imperative description of the step.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'complete', 'cancelled'], description: 'Item state (default pending).' },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
        merge: { type: 'boolean', description: 'Merge into the existing list by id instead of replacing it (default false).' },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const sessionId = context.sessionId ?? 'local';
      if (!Array.isArray(args.todos)) throw new Error('todo_write: todos must be an array');
      const existing = await readTodos(sessionId);
      const merge = Boolean(args.merge);

      let next: TodoItem[];
      if (merge) {
        const byId = new Map(existing.map((item) => [item.id, item]));
        const order = existing.map((item) => item.id);
        for (const [index, value] of args.todos.entries()) {
          const input = normalizeInput(value, index, existing);
          const now = new Date().toISOString();
          if (byId.has(input.id)) byId.set(input.id, { ...byId.get(input.id)!, content: input.content, status: input.status, updatedAt: now });
          else { byId.set(input.id, { id: input.id, content: input.content, status: input.status, updatedAt: now }); order.push(input.id); }
        }
        next = order.map((id) => byId.get(id)!).slice(0, MAX_TODOS);
      } else {
        if (args.todos.length > MAX_TODOS) throw new Error(`todo_write: at most ${MAX_TODOS} items`);
        const acc: TodoItem[] = [];
        const now = new Date().toISOString();
        for (const [index, value] of args.todos.entries()) {
          const input = normalizeInput(value, index, acc);
          acc.push({ id: input.id, content: input.content, status: input.status, updatedAt: now });
        }
        next = acc;
      }

      await writeTodos(sessionId, next);
      return { ok: true, sessionId, todos: next, summary: summarize(next) };
    },
  },
  {
    name: 'todo_read',
    description: 'Return the current task checklist for this session. Use it to re-sync after a restart or before updating statuses.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, context) {
      const sessionId = context.sessionId ?? 'local';
      const todos = await readTodos(sessionId);
      return { ok: true, sessionId, todos, summary: summarize(todos) };
    },
  },
];
