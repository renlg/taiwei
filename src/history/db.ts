import { readFile, readdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPaths } from '../util/paths.js';

type DatabaseSync = import('node:sqlite').DatabaseSync;

export const HISTORY_UNAVAILABLE_MESSAGE = 'history db unavailable (requires Node >= 22.13)';

export class HistoryUnavailableError extends Error {
  constructor() { super(HISTORY_UNAVAILABLE_MESSAGE); this.name = 'HistoryUnavailableError'; }
}

export interface HistorySessionMeta {
  id: string;
  title?: string;
  source?: string;
  model?: string;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
  messageCount?: number;
}

export interface HistoryMessageInput {
  sessionId: string;
  role: string;
  content?: string | null;
  toolName?: string | null;
  timestamp?: number | string | Date;
}

export interface HistorySearchResult {
  sessionId: string;
  title: string;
  source: string;
  timestamp: number;
  snippet: string;
}

export interface HistorySessionSummary {
  sessionId: string;
  title: string;
  source: string;
  messageCount: number;
  updatedAt: number;
}

export interface HistorySession extends HistorySessionSummary {
  model: string | null;
  createdAt: number;
  messages: Array<{ role: string; content: string; toolName: string | null; timestamp: number }>;
}

interface HistoryDatabase { db: DatabaseSync; fts5: boolean }

const databases = new Map<string, Promise<HistoryDatabase>>();

function timeValue(value: number | string | Date | undefined, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function limitValue(value: number | undefined, fallback: number, maximum = 500): number {
  return Math.min(maximum, Math.max(1, Math.floor(Number.isFinite(value) ? value! : fallback)));
}

async function openDatabase(path = getPaths().historyDb): Promise<HistoryDatabase> {
  let pending = databases.get(path);
  if (!pending) {
    pending = (async () => {
      let Database: typeof import('node:sqlite').DatabaseSync;
      try {
        ({ DatabaseSync: Database } = await import('node:sqlite'));
      } catch {
        databases.delete(path);
        throw new HistoryUnavailableError();
      }
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path);
      db.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            source TEXT,
            model TEXT,
            created_at REAL,
            updated_at REAL,
            message_count INTEGER DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_name TEXT,
            timestamp REAL NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(
            session_id, timestamp, role, coalesce(content, ''), coalesce(tool_name, '')
          );
        `);
      let fts5 = true;
      try {
        const hadFts = Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get());
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='id',
            tokenize='trigram'
          );
          CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
          END;
          CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
          END;
          CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
          END;
        `);
        if (!hadFts) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      } catch { fts5 = false; }
      return { db, fts5 };
    })();
    databases.set(path, pending);
  }
  return pending;
}

function upsertSessionIn(db: DatabaseSync, meta: HistorySessionMeta): void {
  const now = Date.now();
  const createdAt = timeValue(meta.createdAt, timeValue(meta.updatedAt, now));
  const updatedAt = timeValue(meta.updatedAt, createdAt);
  db.prepare(`
    INSERT INTO sessions(id, title, source, model, created_at, updated_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END,
      source = CASE WHEN excluded.source <> '' THEN excluded.source ELSE sessions.source END,
      model = coalesce(excluded.model, sessions.model),
      created_at = min(sessions.created_at, excluded.created_at),
      updated_at = max(sessions.updated_at, excluded.updated_at),
      message_count = max(sessions.message_count, excluded.message_count)
  `).run(meta.id, meta.title ?? '', meta.source ?? '', meta.model ?? null, createdAt, updatedAt, Math.max(0, meta.messageCount ?? 0));
}

function appendMessageIn(db: DatabaseSync, message: HistoryMessageInput): boolean {
  const timestamp = timeValue(message.timestamp);
  upsertSessionIn(db, { id: message.sessionId, updatedAt: timestamp });
  const result = db.prepare(`
    INSERT OR IGNORE INTO messages(session_id, role, content, tool_name, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(message.sessionId, message.role, message.content ?? '', message.toolName ?? null, timestamp);
  if (Number(result.changes) > 0) {
    db.prepare(`
      UPDATE sessions SET
        message_count = (SELECT count(*) FROM messages WHERE session_id = ?),
        updated_at = max(updated_at, ?)
      WHERE id = ?
    `).run(message.sessionId, timestamp, message.sessionId);
    return true;
  }
  return false;
}

export async function isHistoryAvailable(): Promise<boolean> {
  try { await openDatabase(); return true; } catch { return false; }
}

export async function upsertSession(meta: HistorySessionMeta): Promise<void> {
  upsertSessionIn((await openDatabase()).db, meta);
}

export async function appendMessage(message: HistoryMessageInput): Promise<boolean> {
  return appendMessageIn((await openDatabase()).db, message);
}

interface JsonSession {
  id?: unknown;
  title?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  usage?: { model?: unknown };
  messages?: Array<{
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    toolCalls?: Array<{ name?: unknown; result?: unknown }>;
  }>;
}

export async function importSessionJson(path: string): Promise<boolean> {
  const value = JSON.parse(await readFile(path, 'utf8')) as JsonSession;
  if (typeof value.id !== 'string' || !Array.isArray(value.messages)) return false;
  const { db } = await openDatabase();
  const existing = db.prepare('SELECT 1 AS found FROM sessions WHERE id = ?').get(value.id) as { found?: number } | undefined;
  if (existing) return false;
  db.exec('BEGIN');
  try {
    upsertSessionIn(db, {
      id: value.id,
      title: typeof value.title === 'string' ? value.title : '',
      source: 'gateway',
      model: typeof value.usage?.model === 'string' ? value.usage.model : undefined,
      createdAt: typeof value.createdAt === 'string' || typeof value.createdAt === 'number' ? value.createdAt : undefined,
      updatedAt: typeof value.updatedAt === 'string' || typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    });
    for (const message of value.messages) {
      if (typeof message.role !== 'string') continue;
      const timestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp : undefined;
      appendMessageIn(db, {
        sessionId: value.id, role: message.role,
        content: typeof message.content === 'string' ? message.content : '', timestamp,
      });
      for (const tool of message.toolCalls ?? []) {
        appendMessageIn(db, {
          sessionId: value.id, role: 'tool',
          content: typeof tool.result === 'string' ? tool.result : '',
          toolName: typeof tool.name === 'string' ? tool.name : undefined,
          timestamp,
        });
      }
    }
    upsertSessionIn(db, {
      id: value.id,
      title: typeof value.title === 'string' ? value.title : '', source: 'gateway',
      model: typeof value.usage?.model === 'string' ? value.usage.model : undefined,
      createdAt: typeof value.createdAt === 'string' || typeof value.createdAt === 'number' ? value.createdAt : undefined,
      updatedAt: typeof value.updatedAt === 'string' || typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    });
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function makeSnippet(content: string, query: string): string {
  const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return Array.from(content).slice(0, 160).join('');
  const before = content.slice(0, index);
  const start = before.length - Array.from(before).slice(-80).join('').length;
  const matchedEnd = index + query.length;
  const end = matchedEnd + Array.from(content.slice(matchedEnd)).slice(0, 80).join('').length;
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

export async function searchMessages(query: string, limit = 5): Promise<HistorySearchResult[]> {
  const clean = query.trim();
  const { db, fts5 } = await openDatabase();
  if (!clean) return [];
  const count = limitValue(limit, 5, 100);
  type Row = { session_id: string; title: string | null; source: string | null; timestamp: number; content: string | null };
  let rows: Row[];
  if (Array.from(clean).length < 3 || !fts5) {
    rows = db.prepare(`
      SELECT m.session_id, s.title, s.source, m.timestamp, m.content
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.content LIKE ? ESCAPE '\\'
      ORDER BY m.timestamp DESC, m.id DESC LIMIT ?
    `).all(`%${clean.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, count) as unknown as Row[];
  } else {
    const expression = `"${clean.replaceAll('"', '""')}"`;
    rows = db.prepare(`
      SELECT m.session_id, s.title, s.source, m.timestamp, m.content
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
      ORDER BY m.timestamp DESC, m.id DESC LIMIT ?
    `).all(expression, count) as unknown as Row[];
  }
  return rows.map((row) => ({
    sessionId: row.session_id,
    title: row.title ?? '',
    source: row.source ?? '',
    timestamp: row.timestamp,
    snippet: makeSnippet(row.content ?? '', clean),
  }));
}

export async function listSessions(limit = 10): Promise<HistorySessionSummary[]> {
  const rows = (await openDatabase()).db.prepare(`
    SELECT id, title, source, message_count, updated_at
    FROM sessions ORDER BY updated_at DESC LIMIT ?
  `).all(limitValue(limit, 10)) as unknown as Array<{ id: string; title: string | null; source: string | null; message_count: number; updated_at: number }>;
  return rows.map((row) => ({ sessionId: row.id, title: row.title ?? '', source: row.source ?? '', messageCount: row.message_count, updatedAt: row.updated_at }));
}

export async function getSession(id: string, maxMessages = 50): Promise<HistorySession | undefined> {
  const { db } = await openDatabase();
  const meta = db.prepare(`
    SELECT id, title, source, model, created_at, updated_at, message_count FROM sessions WHERE id = ?
  `).get(id) as { id: string; title: string | null; source: string | null; model: string | null; created_at: number; updated_at: number; message_count: number } | undefined;
  if (!meta) return undefined;
  const messages = db.prepare(`
    SELECT role, content, tool_name, timestamp FROM (
      SELECT id, role, content, tool_name, timestamp FROM messages
      WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?
    ) ORDER BY timestamp ASC, id ASC
  `).all(id, limitValue(maxMessages, 50)) as unknown as Array<{ role: string; content: string | null; tool_name: string | null; timestamp: number }>;
  return {
    sessionId: meta.id, title: meta.title ?? '', source: meta.source ?? '', model: meta.model,
    createdAt: meta.created_at, updatedAt: meta.updated_at, messageCount: meta.message_count,
    messages: messages.map((message) => ({ role: message.role, content: message.content ?? '', toolName: message.tool_name, timestamp: message.timestamp })),
  };
}

export async function countSessions(): Promise<number> {
  const row = (await openDatabase()).db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number };
  return Number(row.count);
}

export async function rebuildHistoryDb(directory = getPaths().sessions): Promise<number> {
  const { db } = await openDatabase();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM messages; DELETE FROM sessions;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  let files: string[];
  try { files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let imported = 0;
  for (const file of files) {
    try { if (await importSessionJson(join(directory, file))) imported += 1; }
    catch (error) { console.warn(`[taiwei] Skipped invalid history session ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return imported;
}

export async function importHistoryIfEmpty(directory = getPaths().sessions): Promise<number> {
  if (await countSessions() > 0) return 0;
  let files: string[];
  try { files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let imported = 0;
  for (const file of files) {
    try { if (await importSessionJson(join(directory, file))) imported += 1; }
    catch (error) { console.warn(`[taiwei] Skipped invalid history session ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return imported;
}

/** Test helper: closes cached handles so an isolated TAIWEI_HOME can be removed safely. */
export async function closeHistoryDatabases(): Promise<void> {
  for (const pending of databases.values()) {
    try { (await pending).db.close(); } catch {}
  }
  databases.clear();
}
