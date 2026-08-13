import { CronExpressionParser } from 'cron-parser';
import type { CronJob, CronJobStore } from './jobs.js';

export function parseInterval(schedule: string): number | null {
  const match = schedule.trim().toLowerCase().match(/^(?:every\s+)?(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return null;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const value = Number(match[1]) * units[match[2]];
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function nextRun(schedule: string, now = new Date()): Date {
  const interval = parseInterval(schedule);
  if (interval !== null) return new Date(now.getTime() + interval);
  try { return CronExpressionParser.parse(schedule, { currentDate: now }).next().toDate(); }
  catch (error) { throw new Error(`Invalid schedule "${schedule}": ${(error as Error).message}`); }
}

export class CronScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly store: CronJobStore, private readonly execute: (job: CronJob) => Promise<void>) {}

  async start(): Promise<void> { await this.reload(); }
  stop(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  async reload(): Promise<void> {
    this.stop();
    for (const job of await this.store.list()) if (job.enabled) this.schedule(job);
  }

  private schedule(job: CronJob): void {
    let delay: number;
    try { delay = Math.max(1, nextRun(job.schedule).getTime() - Date.now()); }
    catch (error) { console.error(`[taiwei] Skipping cron job "${job.name}": ${(error as Error).message}`); return; }
    const maxDelay = 2_147_483_647;
    const timer = setTimeout(async () => {
      if (delay > maxDelay) { this.schedule(job); return; }
      try { await this.execute(job); }
      catch (error) { console.error(`[taiwei] Cron job "${job.name}" failed: ${(error as Error).message}`); }
      finally { this.schedule(job); }
    }, Math.min(delay, maxDelay));
    timer.unref();
    this.timers.set(job.id, timer);
  }
}
