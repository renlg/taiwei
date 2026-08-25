import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isStateUnavailable, openStateDatabase, type StateDatabase } from '../state/db.js';
import { getPaths } from '../util/paths.js';

export type CronRunStatus = 'ok' | 'error' | 'timeout' | 'skipped';
export interface CronRun {
  jobId: string;
  kind: 'agent' | 'script' | 'command';
  startedAt: string;
  endedAt: string;
  status: CronRunStatus;
  error?: string;
  output?: string;
  tokens?: number;
  exitCode?: number;
}

export class CronRunLedger {
  private readonly last = new Map<string, CronRun[]>();
  private readonly databasePath: string;
  private sqliteUnavailable = false;
  private initialized = false;
  constructor(private readonly capacity = 20, private readonly file = getPaths().cronRuns) {
    this.databasePath = join(dirname(file), 'state.db');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const state = await this.state();
    if (state) {
      await this.migrateLegacy(state);
      const rows = await state.serial((db) => db.prepare('SELECT * FROM cron_runs ORDER BY started_at, id').all() as unknown as CronRunRow[]);
      for (const row of rows) this.remember(runFromRow(row));
      this.initialized = true;
      return;
    }
    try {
      for (const line of (await readFile(this.file, 'utf8')).split('\n').filter(Boolean)) {
        try { this.remember(JSON.parse(line) as CronRun); } catch { /* tolerate a partial final line */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.initialized = true;
  }

  async append(run: CronRun): Promise<void> {
    await this.initialize();
    const state = await this.state();
    if (state) await state.serial((db) => insertRun(db, run));
    else {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(run)}\n`, 'utf8');
    }
    this.remember(run);
  }

  async list(jobId?: string, limit = 100): Promise<CronRun[]> {
    await this.initialize();
    const state = await this.state();
    if (state) {
      const safeLimit = Math.max(1, Math.floor(limit));
      return state.serial((db) => {
        const rows = jobId
          ? db.prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(jobId, safeLimit)
          : db.prepare('SELECT * FROM cron_runs ORDER BY started_at DESC, id DESC LIMIT ?').all(safeLimit);
        return (rows as unknown as CronRunRow[]).map(runFromRow);
      });
    }
    try {
      const values = (await readFile(this.file, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as CronRun]; } catch { return []; }
      });
      return values.filter((run) => !jobId || run.jobId === jobId).slice(-Math.max(1, limit)).reverse();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  lastRuns(jobId: string): CronRun[] { return [...(this.last.get(jobId) ?? [])].reverse(); }
  private remember(run: CronRun): void {
    const values = this.last.get(run.jobId) ?? [];
    values.push(run); if (values.length > this.capacity) values.splice(0, values.length - this.capacity);
    this.last.set(run.jobId, values);
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
    let content: string;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const alreadyImported = await state.serial((db) => Boolean(db.prepare('SELECT 1 AS found FROM state_migrations WHERE source = ?').get(this.file)));
    if (!alreadyImported) {
      const runs = content.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as CronRun]; } catch { return []; }
      });
      await state.serial((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const run of runs) insertRun(db, run);
          db.prepare('INSERT INTO state_migrations(source, imported_at) VALUES (?, ?)').run(this.file, new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    }
    await rename(this.file, `${this.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
}

interface CronRunRow {
  job_id: string; kind: CronRun['kind']; started_at: string; ended_at: string; status: CronRunStatus;
  error: string | null; output: string | null; tokens: number | null; exit_code: number | null;
}

function runFromRow(row: CronRunRow): CronRun {
  return {
    jobId: row.job_id, kind: row.kind, startedAt: row.started_at, endedAt: row.ended_at, status: row.status,
    ...(row.error !== null ? { error: row.error } : {}), ...(row.output !== null ? { output: row.output } : {}),
    ...(row.tokens !== null ? { tokens: row.tokens } : {}), ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
  };
}

function insertRun(db: import('../state/db.js').DatabaseSync, run: CronRun): void {
  db.prepare(`INSERT INTO cron_runs(job_id, kind, started_at, ended_at, status, error, output, tokens, exit_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(run.jobId, run.kind, run.startedAt, run.endedAt, run.status, run.error ?? null, run.output ?? null, run.tokens ?? null, run.exitCode ?? null);
}
