import { CronExpressionParser } from 'cron-parser';
import type { CronJob, CronJobStore } from './jobs.js';
import { CronRunLedger, type CronRun } from './runs.js';
import { appendAudit } from '../observability/audit.js';

export interface CronExecutionResult { output?: string; tokens?: number; exitCode?: number; silent?: boolean }
export type CronExecutor = (job: CronJob, signal: AbortSignal) => Promise<CronExecutionResult | void>;
export type CronDelivery = (job: CronJob, run: CronRun, silent: boolean) => Promise<void>;

export function parseInterval(schedule: string): number | null {
  const match = schedule.trim().toLowerCase().match(/^(?:every\s+)?(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return null;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const value = Number(match[1]) * units[match[2]];
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function nextRun(schedule: string, now = new Date(), timezone = 'local'): Date {
  const interval = parseInterval(schedule);
  if (interval !== null) return new Date(now.getTime() + interval);
  try { return CronExpressionParser.parse(schedule, { currentDate: now, ...(timezone !== 'local' ? { tz: timezone } : {}) }).next().toDate(); }
  catch (error) { throw new Error(`Invalid schedule "${schedule}": ${(error as Error).message}`); }
}

export function jobNextRun(job: CronJob, now = new Date()): Date | undefined {
  if (job.at) {
    const value = new Date(job.at);
    if (!Number.isFinite(value.getTime())) throw new Error(`Invalid one-shot timestamp "${job.at}"`);
    return value;
  }
  return job.schedule ? nextRun(job.schedule, now, job.timezone) : undefined;
}

export class CronScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, number>();
  private readonly queued = new Set<string>();
  readonly ledger: CronRunLedger;
  constructor(
    private readonly store: CronJobStore,
    private readonly execute: CronExecutor,
    private readonly deliver?: CronDelivery,
    ledger = new CronRunLedger(),
    private readonly now: () => Date = () => new Date(),
  ) { this.ledger = ledger; }

  async start(): Promise<void> { await this.ledger.initialize(); await this.reload(); }
  stop(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  async reload(): Promise<void> {
    this.stop();
    for (const job of await this.store.list()) {
      if (!job.enabled) continue;
      if (job.schedule && job.lastScheduledAt) {
        const previous = new Date(job.lastScheduledAt);
        if (Number.isFinite(previous.getTime()) && nextRun(job.schedule, previous, job.timezone).getTime() <= this.now().getTime()) {
          if (job.misfirePolicy === 'run') void this.trigger(job, 'scheduled').catch((error) => console.error(`[taiwei] Cron misfire "${job.name}" failed: ${(error as Error).message}`));
          else await this.recordSkipped(job, 'missed schedule while scheduler was stopped');
        }
      }
      if (job.at && new Date(job.at).getTime() <= this.now().getTime()) {
        if (job.misfirePolicy === 'run' && !job.lastScheduledAt) void this.trigger(job, 'scheduled');
        else if (!job.lastScheduledAt) await this.recordSkipped(job, 'missed one-shot schedule');
        continue;
      }
      this.schedule(job);
    }
  }

  async runNow(id: string): Promise<CronRun> {
    const job = (await this.store.list()).find((item) => item.id === id);
    if (!job) throw new Error(`Cron job not found: ${id}`);
    return this.trigger(job, 'manual');
  }

  next(job: CronJob): Date | undefined { return jobNextRun(job, this.now()); }

  private schedule(job: CronJob): void {
    let fireAt: Date | undefined;
    try { fireAt = jobNextRun(job, this.now()); }
    catch (error) { console.error(`[taiwei] Skipping cron job "${job.name}": ${(error as Error).message}`); return; }
    if (!fireAt) return;
    const delay = Math.max(1, fireAt.getTime() - this.now().getTime());
    const maxDelay = 2_147_483_647;
    const timer = setTimeout(async () => {
      if (delay > maxDelay) { this.schedule(job); return; }
      await this.trigger(job, 'scheduled').catch((error) => console.error(`[taiwei] Cron job "${job.name}" failed: ${(error as Error).message}`));
      if (job.at) { await this.store.update(job.id, { enabled: false, lastScheduledAt: fireAt!.toISOString() }); return; }
      this.schedule(job);
    }, Math.min(delay, maxDelay));
    timer.unref(); this.timers.set(job.id, timer);
  }

  private async trigger(job: CronJob, source: 'scheduled' | 'manual'): Promise<CronRun> {
    const active = this.running.get(job.id) ?? 0;
    if (active && job.overlapPolicy === 'skip') return this.recordSkipped(job, 'overlap policy skipped run');
    if (active && job.overlapPolicy === 'queue') {
      if (this.queued.has(job.id)) return this.recordSkipped(job, 'overlap queue already contains a run');
      this.queued.add(job.id);
      while ((this.running.get(job.id) ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, 10));
      this.queued.delete(job.id);
    }
    this.running.set(job.id, (this.running.get(job.id) ?? 0) + 1);
    const startedAt = this.now().toISOString();
    let run: CronRun;
    let silent = false;
    try {
      let result: CronExecutionResult = {};
      let finalError: unknown;
      let timedOut = false;
      for (let attempt = 0; attempt <= job.retries; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, job.retryDelay * 2 ** (attempt - 1)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), job.timeout);
        try { result = (await this.execute(job, controller.signal)) ?? {}; finalError = undefined; timedOut = false; clearTimeout(timer); break; }
        catch (error) { clearTimeout(timer); finalError = error; timedOut = controller.signal.aborted || (error as Error).name === 'AbortError'; }
      }
      silent = Boolean(result.silent);
      run = finalError ? {
        jobId: job.id, kind: job.kind, startedAt, endedAt: this.now().toISOString(), status: timedOut ? 'timeout' : 'error',
        error: finalError instanceof Error ? finalError.message : String(finalError),
        ...((finalError as { output?: string })?.output ? { output: (finalError as { output: string }).output } : {}),
        ...((finalError as { exitCode?: number })?.exitCode !== undefined ? { exitCode: (finalError as { exitCode: number }).exitCode } : {}),
      } : {
        jobId: job.id, kind: job.kind, startedAt, endedAt: this.now().toISOString(), status: 'ok',
        ...(result.output !== undefined ? { output: result.output } : {}), ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      };
    } finally { this.running.set(job.id, Math.max(0, (this.running.get(job.id) ?? 1) - 1)); }
    await this.ledger.append(run!);
    await appendAudit({ type: 'cron.run', runId: `cron:${job.id}:${startedAt}`, sessionId: `cron:${job.id}`, outcome: run!.status, jobId: job.id, ledger: 'state.db:cron_runs' }).catch(() => {});
    if (source === 'scheduled') await this.store.update(job.id, { lastScheduledAt: this.now().toISOString() });
    if (this.deliver && !(silent && run!.status === 'ok')) await this.deliver(job, run!, silent);
    return run!;
  }

  private async recordSkipped(job: CronJob, error: string): Promise<CronRun> {
    const timestamp = this.now().toISOString();
    const run: CronRun = { jobId: job.id, kind: job.kind, startedAt: timestamp, endedAt: timestamp, status: 'skipped', error };
    await this.ledger.append(run);
    await appendAudit({ type: 'cron.run', runId: `cron:${job.id}:${timestamp}`, sessionId: `cron:${job.id}`, outcome: 'skipped', jobId: job.id, ledger: 'state.db:cron_runs' }).catch(() => {});
    return run;
  }
}
