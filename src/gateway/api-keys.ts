import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getPaths } from '../util/paths.js';

export interface ApiKeyRecord {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function safeName(value: string | undefined, fallback: string): string {
  const sanitized = value?.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return sanitized || fallback;
}

export class ApiKeyStore {
  private operation = Promise.resolve();

  constructor(private readonly file = getPaths().apiKeys) {}

  async list(): Promise<ApiKeyRecord[]> {
    return this.serial(async () => (await this.read()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async create(name?: string, expiresInDays?: number): Promise<{ record: ApiKeyRecord; key: string }> {
    return this.serial(async () => {
      const records = await this.read();
      const key = `twk_${randomBytes(24).toString('hex')}`;
      const now = new Date();
      const record: ApiKeyRecord = {
        id: randomUUID(),
        name: safeName(name, `api-key-${records.length + 1}`),
        hash: hashKey(key),
        prefix: key.slice(0, 8),
        createdAt: now.toISOString(),
        ...(expiresInDays !== undefined
          ? { expiresAt: new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1_000).toISOString() }
          : {}),
      };
      records.push(record);
      await this.persist(records);
      return { record: { ...record }, key };
    });
  }

  async verify(key: string): Promise<ApiKeyRecord | undefined> {
    return this.serial(async () => {
      const records = await this.read();
      const candidate = Buffer.from(hashKey(key), 'hex');
      const now = new Date();
      const record = records.find((item) => {
        if (!/^[a-f0-9]{64}$/i.test(item.hash)) return false;
        return timingSafeEqual(candidate, Buffer.from(item.hash, 'hex'));
      });
      if (!record || (record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime())) return undefined;
      record.lastUsedAt = now.toISOString();
      await this.persist(records);
      return { ...record };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.serial(async () => {
      const records = await this.read();
      const remaining = records.filter((record) => record.id !== id);
      if (remaining.length === records.length) return false;
      await this.persist(remaining);
      return true;
    });
  }

  private async read(): Promise<ApiKeyRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is ApiKeyRecord => Boolean(item && typeof item === 'object'
        && typeof (item as ApiKeyRecord).id === 'string'
        && typeof (item as ApiKeyRecord).name === 'string'
        && typeof (item as ApiKeyRecord).hash === 'string'
        && typeof (item as ApiKeyRecord).prefix === 'string'
        && typeof (item as ApiKeyRecord).createdAt === 'string'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  private async persist(records: ApiKeyRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
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
