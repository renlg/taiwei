import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getPaths } from '../util/paths.js';

export type DatabaseSync = import('node:sqlite').DatabaseSync;

export const STATE_UNAVAILABLE_MESSAGE = 'state db unavailable (requires Node >= 22.13); using legacy JSON storage';

export class StateUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(STATE_UNAVAILABLE_MESSAGE, options);
    this.name = 'StateUnavailableError';
  }
}

export class StateDatabase {
  private operation = Promise.resolve();

  constructor(readonly path: string, readonly db: DatabaseSync) {}

  async serial<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(this.db); }
    finally { release(); }
  }

  close(): void { this.db.close(); }
}

const databases = new Map<string, Promise<StateDatabase>>();

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL DEFAULT 'admin',
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      agent_id TEXT,
      provider_id TEXT,
      current_model TEXT,
      folder_id TEXT,
      identity TEXT,
      usage TEXT,
      messages TEXT NOT NULL DEFAULT '[]',
      context_messages TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT,
      at TEXT,
      kind TEXT NOT NULL,
      prompt TEXT,
      script TEXT,
      command TEXT,
      timezone TEXT NOT NULL,
      timeout INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      overlap_policy TEXT NOT NULL,
      misfire_policy TEXT NOT NULL,
      delivery TEXT NOT NULL,
      retries INTEGER NOT NULL,
      retry_delay INTEGER NOT NULL,
      last_scheduled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      output TEXT,
      tokens INTEGER,
      exit_code INTEGER
    );

    CREATE TABLE IF NOT EXISTS gateway_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_locks (
      kind TEXT NOT NULL,
      lock_key TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY(kind, lock_key)
    );

    CREATE TABLE IF NOT EXISTS state_migrations (
      source TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_owner_created ON sessions(owner, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_owner_folder ON sessions(owner, folder_id);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job_id, started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expires ON gateway_sessions(expires_at);
  `);

  // Keep upgrades idempotent if a development version of state.db already exists.
  const sessionColumns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name));
  const migrations: Array<[string, string]> = [
    ['owner', "TEXT NOT NULL DEFAULT 'admin'"], ['agent_id', 'TEXT'], ['provider_id', 'TEXT'],
    ['current_model', 'TEXT'], ['folder_id', 'TEXT'], ['identity', 'TEXT'], ['usage', 'TEXT'],
    ['messages', "TEXT NOT NULL DEFAULT '[]'"], ['context_messages', 'TEXT'],
    ['message_count', 'INTEGER NOT NULL DEFAULT 0'], ['running', 'INTEGER NOT NULL DEFAULT 0'],
    ['revision', 'INTEGER NOT NULL DEFAULT 1'],
  ];
  for (const [name, definition] of migrations) {
    if (!sessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
  }
}

export async function openStateDatabase(path = getPaths().stateDb): Promise<StateDatabase> {
  if (process.env.TAIWEI_DISABLE_SQLITE === '1') throw new StateUnavailableError();
  let pending = databases.get(path);
  if (!pending) {
    pending = (async () => {
      let Database: typeof import('node:sqlite').DatabaseSync;
      try { ({ DatabaseSync: Database } = await import('node:sqlite')); }
      catch (error) { throw new StateUnavailableError({ cause: error }); }
      await mkdir(dirname(path), { recursive: true });
      const db = new Database(path);
      try { initializeSchema(db); }
      catch (error) { db.close(); throw error; }
      return new StateDatabase(path, db);
    })().catch((error) => {
      databases.delete(path);
      throw error;
    });
    databases.set(path, pending);
  }
  return pending;
}

export function isStateUnavailable(error: unknown): error is StateUnavailableError {
  return error instanceof StateUnavailableError;
}

export async function closeStateDatabases(): Promise<void> {
  const pending = [...databases.values()];
  databases.clear();
  for (const database of pending) {
    try { (await database).close(); } catch { /* unavailable/open failure */ }
  }
}
