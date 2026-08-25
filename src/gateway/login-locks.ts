import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isStateUnavailable, openStateDatabase, type DatabaseSync, type StateDatabase } from '../state/db.js';
import { getPaths } from '../util/paths.js';

export const LOGIN_WINDOW_MS = 10 * 60 * 1_000;
export const LOGIN_COOLDOWN_MS = 10 * 60 * 1_000;
export const PAIR_WINDOW_FAILURES = 5;
export const PAIR_PERMANENT_FAILURES = 10;
export const IP_WINDOW_FAILURES = 10;

interface PairFailures {
  totalFailures: number;
  recentFailures: number[];
  cooldownUntil?: number;
  permanent?: boolean;
}

interface IpFailures {
  recentFailures: number[];
  cooldownUntil?: number;
}

interface LoginLockFile {
  pairs: Record<string, PairFailures>;
  ips: Record<string, IpFailures>;
}

export type LoginLock = 'pair_cooldown' | 'pair_permanent' | 'ip_cooldown';

export interface LoginAttemptResult {
  lock?: LoginLock;
  failed: boolean;
}

function pairKey(username: string, ip: string): string {
  return JSON.stringify([username, ip]);
}

export class LoginLockStore {
  private state: LoginLockFile = { pairs: {}, ips: {} };
  private initialized = false;
  private operation = Promise.resolve();
  private readonly databasePath: string;
  private sqliteUnavailable = false;

  constructor(private readonly file = getPaths().loginLocks) { this.databasePath = join(dirname(file), 'state.db'); }

  async initialize(): Promise<void> {
    await this.serial(async () => {
      if (this.initialized) return;
      await mkdir(dirname(this.file), { recursive: true });
      const sqlite = await this.sqlite();
      if (sqlite) {
        await this.migrateLegacy(sqlite);
        this.initialized = true;
        return;
      }
      try {
        const value = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LoginLockFile>;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a lock-state object');
        this.state = {
          pairs: value.pairs && typeof value.pairs === 'object' ? value.pairs : {},
          ips: value.ips && typeof value.ips === 'object' ? value.ips : {},
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Invalid login lock file at ${this.file}: ${(error as Error).message}`);
        }
      }
      this.initialized = true;
    });
  }

  async attempt(username: string, ip: string, valid: boolean, now = Date.now()): Promise<LoginAttemptResult> {
    await this.initialize();
    const sqlite = await this.sqlite();
    if (sqlite) {
      return sqlite.serial((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const state = readLockState(db);
          const result = applyAttempt(state, username, ip, valid, now);
          writeLockState(db, state);
          db.exec('COMMIT');
          return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    }
    return this.serial(async () => {
      const result = applyAttempt(this.state, username, ip, valid, now);
      await this.persist();
      return result;
    });
  }

  private async persist(): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
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

  private async sqlite(): Promise<StateDatabase | undefined> {
    if (this.sqliteUnavailable) return undefined;
    try { return await openStateDatabase(this.databasePath); }
    catch (error) {
      if (!isStateUnavailable(error)) throw error;
      this.sqliteUnavailable = true;
      return undefined;
    }
  }

  private async migrateLegacy(sqlite: StateDatabase): Promise<void> {
    let value: Partial<LoginLockFile>;
    try { value = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LoginLockFile>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error(`Invalid login lock file at ${this.file}: ${(error as Error).message}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid login lock file at ${this.file}: expected a lock-state object`);
    const state: LoginLockFile = {
      pairs: value.pairs && typeof value.pairs === 'object' ? value.pairs : {},
      ips: value.ips && typeof value.ips === 'object' ? value.ips : {},
    };
    const imported = await sqlite.serial((db) => Boolean(db.prepare('SELECT 1 AS found FROM state_migrations WHERE source = ?').get(this.file)));
    if (!imported) {
      await sqlite.serial((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          writeLockState(db, state);
          db.prepare('INSERT INTO state_migrations(source, imported_at) VALUES (?, ?)').run(this.file, new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    }
    await rename(this.file, `${this.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
}

function applyAttempt(state: LoginLockFile, username: string, ip: string, valid: boolean, now: number): LoginAttemptResult {
  const key = pairKey(username, ip);
  const pair = state.pairs[key];
  const ipState = state.ips[ip];
  if (pair?.permanent) return { lock: 'pair_permanent', failed: false };
  if (ipState?.cooldownUntil && ipState.cooldownUntil > now) return { lock: 'ip_cooldown', failed: false };
  if (pair?.cooldownUntil && pair.cooldownUntil > now) return { lock: 'pair_cooldown', failed: false };
  if (valid) {
    if (pair) delete state.pairs[key];
    return { failed: false };
  }
  const cutoff = now - LOGIN_WINDOW_MS;
  const activePair = pair ?? { totalFailures: 0, recentFailures: [] };
  activePair.recentFailures = activePair.recentFailures.filter((timestamp) => timestamp > cutoff);
  activePair.recentFailures.push(now);
  activePair.totalFailures += 1;
  if (activePair.recentFailures.length >= PAIR_WINDOW_FAILURES) activePair.cooldownUntil = now + LOGIN_COOLDOWN_MS;
  if (activePair.totalFailures >= PAIR_PERMANENT_FAILURES) activePair.permanent = true;
  state.pairs[key] = activePair;
  const activeIp = ipState ?? { recentFailures: [] };
  activeIp.recentFailures = activeIp.recentFailures.filter((timestamp) => timestamp > cutoff);
  activeIp.recentFailures.push(now);
  if (activeIp.recentFailures.length >= IP_WINDOW_FAILURES) activeIp.cooldownUntil = now + LOGIN_COOLDOWN_MS;
  state.ips[ip] = activeIp;
  return { failed: true };
}

function readLockState(db: DatabaseSync): LoginLockFile {
  const state: LoginLockFile = { pairs: {}, ips: {} };
  for (const row of db.prepare('SELECT kind, lock_key, state FROM login_locks').all() as unknown as Array<{ kind: string; lock_key: string; state: string }>) {
    if (row.kind === 'pair') state.pairs[row.lock_key] = JSON.parse(row.state) as PairFailures;
    else if (row.kind === 'ip') state.ips[row.lock_key] = JSON.parse(row.state) as IpFailures;
  }
  return state;
}

function writeLockState(db: DatabaseSync, state: LoginLockFile): void {
  db.exec('DELETE FROM login_locks');
  const insert = db.prepare('INSERT INTO login_locks(kind, lock_key, state) VALUES (?, ?, ?)');
  for (const [key, value] of Object.entries(state.pairs)) insert.run('pair', key, JSON.stringify(value));
  for (const [key, value] of Object.entries(state.ips)) insert.run('ip', key, JSON.stringify(value));
}
