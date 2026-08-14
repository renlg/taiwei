import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

  constructor(private readonly file = getPaths().gatewaySessions) {}

  async initialize(): Promise<void> {
    await this.serial(async () => {
      if (this.initialized) return;
      await mkdir(dirname(this.file), { recursive: true });
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
}
