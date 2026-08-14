import { appendFile, readFile } from 'node:fs/promises';
import { ensureTaiweiHome } from '../util/paths.js';

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
  constructor(private readonly capacity = 20) {}

  async initialize(): Promise<void> {
    const { cronRuns } = await ensureTaiweiHome();
    try {
      for (const line of (await readFile(cronRuns, 'utf8')).split('\n').filter(Boolean)) {
        try { this.remember(JSON.parse(line) as CronRun); } catch { /* tolerate a partial final line */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async append(run: CronRun): Promise<void> {
    const { cronRuns } = await ensureTaiweiHome();
    await appendFile(cronRuns, `${JSON.stringify(run)}\n`, 'utf8');
    this.remember(run);
  }

  async list(jobId?: string, limit = 100): Promise<CronRun[]> {
    const { cronRuns } = await ensureTaiweiHome();
    try {
      const values = (await readFile(cronRuns, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
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
}
