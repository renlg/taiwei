import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ChatMessage } from '../llm/client.js';
import { isStateUnavailable, openStateDatabase, type DatabaseSync, type StateDatabase } from '../state/db.js';
import { getPaths } from '../util/paths.js';

export interface SessionToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface SessionAttachment {
  name: string;
  url: string;
  type?: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  agentContent?: string;
  attachments?: SessionAttachment[];
  toolCalls?: SessionToolCall[];
  timestamp: string;
  status?: 'stopped' | 'error' | 'pending';
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  model: string;
  compressed?: boolean;
}

export interface SessionIdentity {
  role: 'admin' | 'guest';
  username: string;
  accountName?: string;
  osUsername?: string;
  giteaUsername?: string;
  giteaOrgName?: string;
}

export interface GatewaySession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  /** Agent-ready history, including compressed summaries and tool-call messages. */
  contextMessages?: ChatMessage[];
  usage?: SessionUsage;
  agentId?: string;
  providerId?: string;
  currentModel?: string;
  folderId?: string;
  identity?: SessionIdentity;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  folderId?: string;
  running?: boolean;
}

const VALID_ID = /^[a-f0-9-]{36}$/i;

function hasValidToolArguments(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeContextMessages(messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = [];
  let removedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      removedToolCallIds = new Set<string>();
      const validCalls = message.tool_calls.filter((call) => {
        const valid = hasValidToolArguments(call?.function?.arguments);
        if (!valid && typeof call?.id === 'string') removedToolCallIds.add(call.id);
        return valid;
      });
      if (validCalls.length === 0) continue;
      sanitized.push(validCalls.length === message.tool_calls.length
        ? message
        : { ...message, tool_calls: validCalls });
      continue;
    }

    if (message.role === 'tool') {
      if (!removedToolCallIds.has(message.tool_call_id)) sanitized.push(message);
      continue;
    }

    removedToolCallIds = new Set<string>();
    sanitized.push(message);
  }

  return sanitized;
}

export class SessionStore {
  static forGuest(guestId: string): SessionStore {
    return new SessionStore(join(getPaths().guests, guestId, 'sessions'));
  }

  static async moveGuestScope(legacyGuestId: string, guestId: string): Promise<void> {
    try {
      const state = await openStateDatabase(getPaths().stateDb);
      await state.serial((db) => db.prepare('UPDATE sessions SET owner = ? WHERE owner = ?')
        .run(`guest:${guestId}`, `guest:${legacyGuestId}`));
    } catch (error) {
      if (!isStateUnavailable(error)) throw error;
    }
  }

  private readonly owner: string;
  private readonly databasePath: string;
  private readonly snapshots = new WeakMap<GatewaySession, { revision: number; value: GatewaySession }>();
  private sqliteUnavailable = false;

  constructor(private readonly directory = getPaths().sessions) {
    const parent = dirname(directory);
    if (basename(dirname(parent)) === 'guests') {
      this.owner = `guest:${basename(parent)}`;
      this.databasePath = join(dirname(dirname(parent)), 'state.db');
    } else {
      this.owner = 'admin';
      this.databasePath = join(parent, 'state.db');
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const state = await this.state();
    if (state) await this.migrateLegacy(state);
  }

  async finalizeStalePending(message = '上次运行因网关重启而中断。'): Promise<number> {
    await this.initialize();
    const state = await this.state();
    let finalized = 0;
    const sessions = state
      ? await this.sqliteSessions(state)
      : await this.jsonSessions();
    for (const session of sessions) {
      try {
        let changed = false;
        for (const pending of session.messages) {
          if (pending.role !== 'assistant' || pending.status !== 'pending') continue;
          pending.status = 'stopped';
          if (!pending.content.trim()) pending.content = message;
          changed = true;
        }
        if (!changed) continue;
        session.updatedAt = new Date().toISOString();
        await this.save(session);
        finalized += 1;
      } catch { /* A malformed session must not prevent gateway startup. */ }
    }
    return finalized;
  }

  async create(agentId = 'build', folderId?: string, currentModel?: string, providerId?: string, identity?: SessionIdentity): Promise<GatewaySession> {
    const now = new Date().toISOString();
    const session: GatewaySession = {
      id: randomUUID(), title: '新会话', createdAt: now, updatedAt: now, messages: [], agentId,
      ...(folderId ? { folderId } : {}), ...(currentModel ? { currentModel } : {}), ...(providerId ? { providerId } : {}),
      ...(identity ? { identity } : {}),
    };
    await this.save(session);
    return session;
  }

  async list(): Promise<SessionSummary[]> {
    await this.initialize();
    const state = await this.state();
    if (state) {
      return state.serial((db) => (db.prepare(`
        SELECT id, title, created_at, updated_at, message_count, folder_id, running
        FROM sessions WHERE owner = ? ORDER BY created_at DESC
      `).all(this.owner) as unknown as SessionSummaryRow[]).map(summaryFromRow));
    }
    return (await this.jsonSessions())
      .map((session) => {
        const last = session.messages.at(-1);
        const running = last?.role === 'assistant' && last.status === 'pending';
        return {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          ...(session.folderId ? { folderId: session.folderId } : {}),
          ...(running ? { running: true } : {}),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findBlankSession(folderId: string): Promise<GatewaySession | undefined> {
    const summaries = await this.list();
    for (const summary of summaries) {
      if (summary.folderId !== folderId) continue;
      if (summary.title !== '新会话') continue;
      if (summary.messageCount !== 0) continue;
      return this.get(summary.id);
    }
    return undefined;
  }

  async get(id: string): Promise<GatewaySession | undefined> {
    if (!VALID_ID.test(id)) return undefined;
    await this.initialize();
    const state = await this.state();
    if (state) {
      const row = await state.serial((db) => db.prepare('SELECT * FROM sessions WHERE id = ? AND owner = ?').get(id, this.owner) as SessionRow | undefined);
      if (!row) return undefined;
      const session = sessionFromRow(row);
      this.snapshots.set(session, { revision: row.revision, value: structuredClone(session) });
      return session;
    }
    try { return await this.readFile(this.path(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(session: GatewaySession): Promise<void> {
    if (!VALID_ID.test(session.id)) throw new Error('Invalid session id');
    await this.initialize();
    const state = await this.state();
    if (state) {
      const saved = await state.serial((db) => {
        const existing = db.prepare('SELECT * FROM sessions WHERE id = ? AND owner = ?').get(session.id, this.owner) as SessionRow | undefined;
        const current = existing ? sessionFromRow(existing) : undefined;
        const snapshot = this.snapshots.get(session);
        const candidate = existing && snapshot && snapshot.revision !== existing.revision
          ? mergeConcurrentSession(snapshot.value, current!, session)
          : structuredClone(session);
        if (!writeSessionRow(db, this.owner, candidate, existing?.revision ?? 0)) {
          throw new Error('Session id belongs to another owner');
        }
        return { value: candidate, revision: (existing?.revision ?? 0) + 1 };
      });
      this.snapshots.set(session, { revision: saved.revision, value: structuredClone(saved.value) });
      return;
    }
    const path = this.path(session.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  async delete(id: string): Promise<boolean> {
    if (!VALID_ID.test(id)) return false;
    await this.initialize();
    const state = await this.state();
    if (state) {
      return state.serial((db) => Number(db.prepare('DELETE FROM sessions WHERE id = ? AND owner = ?').run(id, this.owner).changes) > 0);
    }
    try { await unlink(this.path(id)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async moveFolderSessions(folderId: string, destinationFolderId: string): Promise<number> {
    const summaries = await this.list();
    let moved = 0;
    for (const summary of summaries) {
      if (summary.folderId !== folderId) continue;
      const session = await this.get(summary.id);
      if (!session) continue;
      session.folderId = destinationFolderId;
      session.updatedAt = new Date().toISOString();
      await this.save(session);
      moved += 1;
    }
    return moved;
  }

  toChatHistory(session: GatewaySession): ChatMessage[] {
    return session.contextMessages
      ? sanitizeContextMessages(structuredClone(session.contextMessages))
      : session.messages.map((message) => ({ role: message.role, content: message.agentContent ?? message.content }));
  }

  titleFrom(message: string): string {
    const clean = message.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const characters = Array.from(clean);
    return characters.length > 20 ? `${characters.slice(0, 20).join('')}…` : clean;
  }

  private path(id: string): string { return join(this.directory, `${id}.json`); }

  private async state(): Promise<StateDatabase | undefined> {
    if (this.sqliteUnavailable) return undefined;
    try { return await openStateDatabase(this.databasePath); }
    catch (error) {
      if (!isStateUnavailable(error)) throw error;
      this.sqliteUnavailable = true;
      return undefined;
    }
  }

  private async migrateLegacy(state: StateDatabase): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => join(this.directory, entry.name));
    if (!paths.length) return;
    const imported: string[] = [];
    await state.serial(async (db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const path of paths) {
          try {
            const session = await this.readFile(path);
            insertMigratedSession(db, this.owner, session);
            imported.push(path);
          } catch { /* Leave malformed legacy files in place for manual recovery. */ }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    const suffix = `.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const path of imported) {
      try { await rename(path, `${path}${suffix}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private async sqliteSessions(state: StateDatabase): Promise<GatewaySession[]> {
    return state.serial((db) => (db.prepare('SELECT * FROM sessions WHERE owner = ? ORDER BY created_at DESC').all(this.owner) as unknown as SessionRow[]).map(sessionFromRow));
  }

  private async jsonSessions(): Promise<GatewaySession[]> {
    const files = await readdir(this.directory, { withFileTypes: true });
    const sessions = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map(async (entry) => {
      try { return await this.readFile(join(this.directory, entry.name)); } catch { return undefined; }
    }));
    return sessions.filter((session): session is GatewaySession => Boolean(session));
  }

  private async readFile(path: string): Promise<GatewaySession> {
    const value = JSON.parse(await readFile(path, 'utf8')) as GatewaySession;
    if (!value || typeof value.id !== 'string' || !Array.isArray(value.messages)) throw new Error(`Invalid session file: ${path}`);
    return value;
  }
}

interface SessionRow {
  id: string; owner: string; title: string; created_at: string; updated_at: string;
  agent_id: string | null; provider_id: string | null; current_model: string | null; folder_id: string | null;
  identity: string | null; usage: string | null; messages: string; context_messages: string | null;
  message_count: number; running: number; revision: number;
}

interface SessionSummaryRow {
  id: string; title: string; created_at: string; updated_at: string; message_count: number;
  folder_id: string | null; running: number;
}

function parseJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : JSON.parse(value) as T;
}

function sessionFromRow(row: SessionRow): GatewaySession {
  return {
    id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
    messages: parseJson<SessionMessage[]>(row.messages) ?? [],
    ...(row.context_messages !== null ? { contextMessages: parseJson<ChatMessage[]>(row.context_messages) } : {}),
    ...(row.usage !== null ? { usage: parseJson<SessionUsage>(row.usage) } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}), ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.current_model ? { currentModel: row.current_model } : {}), ...(row.folder_id ? { folderId: row.folder_id } : {}),
    ...(row.identity !== null ? { identity: parseJson<SessionIdentity>(row.identity) } : {}),
  };
}

function summaryFromRow(row: SessionSummaryRow): SessionSummary {
  return {
    id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
    messageCount: row.message_count, ...(row.folder_id ? { folderId: row.folder_id } : {}),
    ...(row.running ? { running: true } : {}),
  };
}

function running(session: GatewaySession): number {
  const last = session.messages.at(-1);
  return last?.role === 'assistant' && last.status === 'pending' ? 1 : 0;
}

function sessionValues(owner: string, session: GatewaySession, revision: number): Array<string | number | null> {
  return [
    session.id, owner, session.title, session.createdAt, session.updatedAt, session.agentId ?? null,
    session.providerId ?? null, session.currentModel ?? null, session.folderId ?? null,
    session.identity ? JSON.stringify(session.identity) : null, session.usage ? JSON.stringify(session.usage) : null,
    JSON.stringify(session.messages), session.contextMessages ? JSON.stringify(session.contextMessages) : null,
    session.messages.length, running(session), revision,
  ];
}

function insertMigratedSession(db: DatabaseSync, owner: string, session: GatewaySession): void {
  db.prepare(`INSERT OR IGNORE INTO sessions(
    id, owner, title, created_at, updated_at, agent_id, provider_id, current_model, folder_id,
    identity, usage, messages, context_messages, message_count, running, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(...sessionValues(owner, session, 1));
}

function writeSessionRow(db: DatabaseSync, owner: string, session: GatewaySession, oldRevision: number): boolean {
  const result = db.prepare(`INSERT INTO sessions(
    id, owner, title, created_at, updated_at, agent_id, provider_id, current_model, folder_id,
    identity, usage, messages, context_messages, message_count, running, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    owner=excluded.owner, title=excluded.title, created_at=excluded.created_at, updated_at=excluded.updated_at,
    agent_id=excluded.agent_id, provider_id=excluded.provider_id, current_model=excluded.current_model,
    folder_id=excluded.folder_id, identity=excluded.identity, usage=excluded.usage, messages=excluded.messages,
    context_messages=excluded.context_messages, message_count=excluded.message_count, running=excluded.running,
    revision=excluded.revision
  WHERE sessions.owner = excluded.owner`)
    .run(...sessionValues(owner, session, oldRevision + 1));
  return Number(result.changes) > 0;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function mergeMessages(base: SessionMessage[], current: SessionMessage[], incoming: SessionMessage[]): SessionMessage[] {
  const key = (message: SessionMessage) => `${message.role}\u0000${message.timestamp}`;
  const baseByKey = new Map(base.map((message) => [key(message), message]));
  const merged = current.map((message) => structuredClone(message));
  const indexes = new Map(merged.map((message, index) => [key(message), index]));
  for (const message of incoming) {
    const id = key(message);
    const index = indexes.get(id);
    const original = baseByKey.get(id);
    if (index === undefined) {
      indexes.set(id, merged.length);
      merged.push(structuredClone(message));
    } else if (!original || !same(original, message)) {
      merged[index] = structuredClone(message);
    }
  }
  return merged;
}

function mergeContext(base: ChatMessage[] | undefined, current: ChatMessage[] | undefined, incoming: ChatMessage[] | undefined): ChatMessage[] | undefined {
  if (same(base, incoming)) return current ? structuredClone(current) : undefined;
  if (!base || !current || !incoming) return incoming ? structuredClone(incoming) : undefined;
  const prefix = (values: ChatMessage[]) => base.every((message, index) => same(values[index], message));
  if (!prefix(current) || !prefix(incoming)) return structuredClone(incoming);
  const merged = [...base, ...current.slice(base.length)];
  for (const message of incoming.slice(base.length)) if (!merged.some((value) => same(value, message))) merged.push(message);
  return structuredClone(merged);
}

function mergeConcurrentSession(base: GatewaySession, current: GatewaySession, incoming: GatewaySession): GatewaySession {
  const select = <K extends keyof GatewaySession>(key: K): GatewaySession[K] => same(base[key], incoming[key]) ? current[key] : incoming[key];
  const contextMessages = mergeContext(base.contextMessages, current.contextMessages, incoming.contextMessages);
  return {
    id: incoming.id,
    title: select('title')!, createdAt: current.createdAt,
    updatedAt: [current.updatedAt, incoming.updatedAt].sort().at(-1)!,
    messages: mergeMessages(base.messages, current.messages, incoming.messages),
    ...(contextMessages ? { contextMessages } : {}),
    ...(select('usage') ? { usage: structuredClone(select('usage')!) } : {}),
    ...(select('agentId') ? { agentId: select('agentId') } : {}),
    ...(select('providerId') ? { providerId: select('providerId') } : {}),
    ...(select('currentModel') ? { currentModel: select('currentModel') } : {}),
    ...(select('folderId') ? { folderId: select('folderId') } : {}),
    ...(select('identity') ? { identity: structuredClone(select('identity')!) } : {}),
  };
}
