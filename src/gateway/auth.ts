import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isStateUnavailable, openStateDatabase, type StateDatabase } from '../state/db.js';
import { getPaths } from '../util/paths.js';

export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AuthSession {
  username: string;
  role?: 'admin' | 'guest';
  createdAt: string;
  expiresAt: string;
}

type AuthSessionFile = Record<string, AuthSession>;

export class AuthSessionStore {
  private sessions: AuthSessionFile = {};
  private initialized = false;
  private operation = Promise.resolve();
  private readonly databasePath: string;
  private sqliteUnavailable = false;

  constructor(private readonly file = getPaths().gatewaySessions) { this.databasePath = join(dirname(file), 'state.db'); }

  async initialize(): Promise<void> {
    await this.serial(async () => {
      if (this.initialized) return;
      await mkdir(dirname(this.file), { recursive: true });
      const state = await this.state();
      if (state) {
        await this.migrateLegacy(state);
        await state.serial((db) => db.prepare('DELETE FROM gateway_sessions WHERE expires_at <= ?').run(new Date().toISOString()));
        this.initialized = true;
        return;
      }
      try {
        const value = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a token map');
        this.sessions = value as AuthSessionFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Invalid gateway session file at ${this.file}: ${(error as Error).message}`);
        }
      }
      this.initialized = true;
      if (this.removeExpired()) await this.persist();
    });
  }

  async create(username: string, role: 'admin' | 'guest' = 'admin'): Promise<string> {
    await this.initialize();
    const state = await this.state();
    if (state) {
      return state.serial((db) => {
        const token = randomBytes(32).toString('hex');
        const now = new Date();
        db.prepare('INSERT INTO gateway_sessions(token, username, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(token, username, role, now.toISOString(), new Date(now.getTime() + AUTH_SESSION_TTL_MS).toISOString());
        return token;
      });
    }
    return this.serial(async () => {
      const token = randomBytes(32).toString('hex');
      const now = new Date();
      this.sessions[token] = {
        username,
        role,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + AUTH_SESSION_TTL_MS).toISOString(),
      };
      await this.persist();
      return token;
    });
  }

  async authenticate(token: string): Promise<AuthSession | undefined> {
    await this.initialize();
    const state = await this.state();
    if (state) {
      return state.serial((db) => {
        const row = db.prepare('SELECT username, role, created_at, expires_at FROM gateway_sessions WHERE token = ?').get(token) as AuthSessionRow | undefined;
        if (!row) return undefined;
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          db.prepare('DELETE FROM gateway_sessions WHERE token = ?').run(token);
          return undefined;
        }
        const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();
        db.prepare('UPDATE gateway_sessions SET expires_at = ? WHERE token = ?').run(expiresAt, token);
        return { username: row.username, ...(row.role ? { role: row.role } : {}), createdAt: row.created_at, expiresAt };
      });
    }
    return this.serial(async () => {
      const session = this.sessions[token];
      if (!session) return undefined;
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        delete this.sessions[token];
        await this.persist();
        return undefined;
      }
      session.expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();
      await this.persist();
      return { ...session };
    });
  }

  async delete(token: string): Promise<void> {
    await this.initialize();
    const state = await this.state();
    if (state) { await state.serial((db) => db.prepare('DELETE FROM gateway_sessions WHERE token = ?').run(token)); return; }
    await this.serial(async () => {
      if (!(token in this.sessions)) return;
      delete this.sessions[token];
      await this.persist();
    });
  }

  private removeExpired(): boolean {
    let changed = false;
    const now = Date.now();
    for (const [token, session] of Object.entries(this.sessions)) {
      if (!session || typeof session.expiresAt !== 'string' || new Date(session.expiresAt).getTime() <= now) {
        delete this.sessions[token];
        changed = true;
      }
    }
    return changed;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.sessions, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

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
    let value: unknown;
    try { value = JSON.parse(await readFile(this.file, 'utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error(`Invalid gateway session file at ${this.file}: ${(error as Error).message}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid gateway session file at ${this.file}: expected a token map`);
    const sessions = value as AuthSessionFile;
    const alreadyImported = await state.serial((db) => Boolean(db.prepare('SELECT 1 AS found FROM state_migrations WHERE source = ?').get(this.file)));
    if (!alreadyImported) {
      await state.serial((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const [token, session] of Object.entries(sessions)) {
            if (!session || typeof session.username !== 'string' || typeof session.createdAt !== 'string' || typeof session.expiresAt !== 'string') continue;
            db.prepare('INSERT OR IGNORE INTO gateway_sessions(token, username, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
              .run(token, session.username, session.role ?? null, session.createdAt, session.expiresAt);
          }
          db.prepare('INSERT INTO state_migrations(source, imported_at) VALUES (?, ?)').run(this.file, new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    }
    await rename(this.file, `${this.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
}

interface AuthSessionRow {
  username: string;
  role: 'admin' | 'guest' | null;
  created_at: string;
  expires_at: string;
}
