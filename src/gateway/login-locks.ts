import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

  constructor(private readonly file = getPaths().loginLocks) {}

  async initialize(): Promise<void> {
    await this.serial(async () => {
      if (this.initialized) return;
      await mkdir(dirname(this.file), { recursive: true });
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
    return this.serial(async () => {
      const key = pairKey(username, ip);
      const pair = this.state.pairs[key];
      const ipState = this.state.ips[ip];
      if (pair?.permanent) return { lock: 'pair_permanent', failed: false };
      if (ipState?.cooldownUntil && ipState.cooldownUntil > now) return { lock: 'ip_cooldown', failed: false };
      if (pair?.cooldownUntil && pair.cooldownUntil > now) return { lock: 'pair_cooldown', failed: false };

      if (valid) {
        if (pair) {
          delete this.state.pairs[key];
          await this.persist();
        }
        return { failed: false };
      }

      const cutoff = now - LOGIN_WINDOW_MS;
      const activePair = pair ?? { totalFailures: 0, recentFailures: [] };
      activePair.recentFailures = activePair.recentFailures.filter((timestamp) => timestamp > cutoff);
      activePair.recentFailures.push(now);
      activePair.totalFailures += 1;
      if (activePair.recentFailures.length >= PAIR_WINDOW_FAILURES) activePair.cooldownUntil = now + LOGIN_COOLDOWN_MS;
      if (activePair.totalFailures >= PAIR_PERMANENT_FAILURES) activePair.permanent = true;
      this.state.pairs[key] = activePair;

      const activeIp = ipState ?? { recentFailures: [] };
      activeIp.recentFailures = activeIp.recentFailures.filter((timestamp) => timestamp > cutoff);
      activeIp.recentFailures.push(now);
      if (activeIp.recentFailures.length >= IP_WINDOW_FAILURES) activeIp.cooldownUntil = now + LOGIN_COOLDOWN_MS;
      this.state.ips[ip] = activeIp;
      await this.persist();
      return { failed: true };
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
}
