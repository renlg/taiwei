import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isStateUnavailable, openStateDatabase, type DatabaseSync, type StateDatabase } from '../state/db.js';
import { getPaths } from '../util/paths.js';

export interface CronJob {
  id: string;
  name: string;
  schedule?: string;
  at?: string;
  kind: 'agent' | 'script' | 'command';
  prompt?: string;
  script?: string;
  command?: string;
  timezone: string;
  timeout: number;
  enabled: boolean;
  overlapPolicy: 'skip' | 'queue' | 'parallel';
  misfirePolicy: 'skip' | 'run';
  delivery: { type: 'console' | 'none' } | { type: 'webhook'; url: string };
  retries: number;
  retryDelay: number;
  lastScheduledAt?: string;
}

export type CronJobInput = Partial<Omit<CronJob, 'id'>> & Pick<CronJob, 'name'>;

const DEFAULT_TIMEOUT = 10 * 60_000;

function normalized(item: Partial<CronJob>, index = 0): CronJob {
  if (!item.id || !item.name) throw new Error(`entry ${index} is missing required fields`);
  if (!item.schedule && !item.at) throw new Error(`entry ${index} requires schedule or at`);
  const kind = item.kind ?? 'agent';
  if (!['agent', 'script', 'command'].includes(kind)) throw new Error(`entry ${index} has invalid kind`);
  const prompt = item.prompt ?? (kind === 'agent' ? '' : undefined);
  if (kind === 'agent' && !prompt) throw new Error(`entry ${index} requires prompt`);
  if (kind === 'script' && !item.script) throw new Error(`entry ${index} requires script`);
  if (kind === 'command' && !item.command) throw new Error(`entry ${index} requires command`);
  const delivery = item.delivery?.type === 'webhook' && item.delivery.url
    ? { type: 'webhook' as const, url: item.delivery.url }
    : item.delivery?.type === 'none' ? { type: 'none' as const } : { type: 'console' as const };
  return {
    id: item.id, name: item.name, ...(item.schedule ? { schedule: item.schedule } : {}), ...(item.at ? { at: item.at } : {}),
    kind, ...(prompt !== undefined ? { prompt } : {}), ...(item.script ? { script: item.script } : {}),
    ...(item.command ? { command: item.command } : {}), timezone: item.timezone || 'local',
    timeout: Number.isFinite(item.timeout) && Number(item.timeout) > 0 ? Number(item.timeout) : DEFAULT_TIMEOUT,
    enabled: item.enabled !== false,
    overlapPolicy: item.overlapPolicy ?? 'skip', misfirePolicy: item.misfirePolicy ?? 'skip', delivery,
    retries: Number.isInteger(item.retries) && Number(item.retries) >= 0 ? Number(item.retries) : 2,
    retryDelay: Number.isFinite(item.retryDelay) && Number(item.retryDelay) >= 0 ? Number(item.retryDelay) : 30_000,
    ...(item.lastScheduledAt ? { lastScheduledAt: item.lastScheduledAt } : {}),
  };
}

export class CronJobStore {
  private readonly databasePath: string;
  private sqliteUnavailable = false;
  private migrated = false;

  constructor(private readonly file = getPaths().cron) { this.databasePath = join(dirname(file), 'state.db'); }

  async list(): Promise<CronJob[]> {
    const state = await this.state();
    if (state) {
      await this.migrateLegacy(state);
      return state.serial((db) => (db.prepare('SELECT * FROM cron_jobs ORDER BY rowid').all() as unknown as CronJobRow[]).map(jobFromRow));
    }
    return this.listJson();
  }

  private async listJson(): Promise<CronJob[]> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('root value must be an array');
      return value.map((item, index) => {
        if (!item || typeof item !== 'object') throw new Error(`entry ${index} must be an object`);
        const job = item as Partial<CronJob>;
        return normalized(job, index);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Invalid cron file: ${(error as Error).message}`);
    }
  }

  private async save(jobs: CronJob[]): Promise<void> {
    const state = await this.state();
    if (state) {
      await this.migrateLegacy(state);
      await state.serial((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('DELETE FROM cron_jobs');
          for (const job of jobs) writeJob(db, job);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      return;
    }
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
  }

  async add(name: string, schedule: string, prompt: string): Promise<CronJob>;
  async add(input: CronJobInput): Promise<CronJob>;
  async add(nameOrInput: string | CronJobInput, schedule?: string, prompt?: string): Promise<CronJob> {
    const input = typeof nameOrInput === 'string' ? { name: nameOrInput, schedule, prompt, kind: 'agent' as const } : nameOrInput;
    const job = normalized({ id: randomUUID().slice(0, 8), ...input });
    const state = await this.state();
    if (state) { await this.migrateLegacy(state); await state.serial((db) => writeJob(db, job)); return job; }
    const jobs = await this.listJson();
    jobs.push(job); await this.save(jobs); return job;
  }

  async update(id: string, patch: Partial<Omit<CronJob, 'id'>>): Promise<CronJob | undefined> {
    const state = await this.state();
    if (state) {
      await this.migrateLegacy(state);
      return state.serial((db) => {
        const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined;
        if (!row) return undefined;
        const job = normalized({ ...jobFromRow(row), ...patch, id });
        db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
        writeJob(db, job);
        return job;
      });
    }
    const jobs = await this.listJson();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return undefined;
    jobs[index] = normalized({ ...jobs[index], ...patch, id });
    await this.save(jobs); return jobs[index];
  }

  async remove(id: string): Promise<boolean> {
    const state = await this.state();
    if (state) { await this.migrateLegacy(state); return state.serial((db) => Number(db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id).changes) > 0); }
    const jobs = await this.listJson();
    const remaining = jobs.filter((job) => job.id !== id);
    if (remaining.length === jobs.length) return false;
    await this.save(remaining); return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const state = await this.state();
    if (state) {
      await this.migrateLegacy(state);
      return state.serial((db) => Number(db.prepare('UPDATE cron_jobs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes) > 0);
    }
    const jobs = await this.listJson();
    const job = jobs.find((item) => item.id === id);
    if (!job) return false;
    job.enabled = enabled; await this.save(jobs); return true;
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
    if (this.migrated) return;
    let jobs: CronJob[];
    try { jobs = await this.listJson(); }
    catch (error) { throw error; }
    try { await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.migrated = true; return; }
      throw error;
    }
    await state.serial((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const job of jobs) writeJob(db, job, true);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    await rename(this.file, `${this.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    this.migrated = true;
  }
}

interface CronJobRow {
  id: string; name: string; schedule: string | null; at: string | null; kind: CronJob['kind'];
  prompt: string | null; script: string | null; command: string | null; timezone: string; timeout: number;
  enabled: number; overlap_policy: CronJob['overlapPolicy']; misfire_policy: CronJob['misfirePolicy'];
  delivery: string; retries: number; retry_delay: number; last_scheduled_at: string | null;
}

function jobFromRow(row: CronJobRow): CronJob {
  return normalized({
    id: row.id, name: row.name, ...(row.schedule ? { schedule: row.schedule } : {}), ...(row.at ? { at: row.at } : {}),
    kind: row.kind, ...(row.prompt !== null ? { prompt: row.prompt } : {}), ...(row.script !== null ? { script: row.script } : {}),
    ...(row.command !== null ? { command: row.command } : {}), timezone: row.timezone, timeout: row.timeout,
    enabled: Boolean(row.enabled), overlapPolicy: row.overlap_policy, misfirePolicy: row.misfire_policy,
    delivery: JSON.parse(row.delivery) as CronJob['delivery'], retries: row.retries, retryDelay: row.retry_delay,
    ...(row.last_scheduled_at ? { lastScheduledAt: row.last_scheduled_at } : {}),
  });
}

function writeJob(db: DatabaseSync, job: CronJob, ignore = false): void {
  db.prepare(`${ignore ? 'INSERT OR IGNORE' : 'INSERT'} INTO cron_jobs(
    id, name, schedule, at, kind, prompt, script, command, timezone, timeout, enabled,
    overlap_policy, misfire_policy, delivery, retries, retry_delay, last_scheduled_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(job.id, job.name, job.schedule ?? null, job.at ?? null, job.kind, job.prompt ?? null, job.script ?? null,
      job.command ?? null, job.timezone, job.timeout, job.enabled ? 1 : 0, job.overlapPolicy, job.misfirePolicy,
      JSON.stringify(job.delivery), job.retries, job.retryDelay, job.lastScheduledAt ?? null);
}
