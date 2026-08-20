import type { CronJob } from '../../cron/jobs.js';
import type { CronJobStore } from '../../cron/jobs.js';
import type { CronScheduler } from '../../cron/scheduler.js';
import type { ToolSpec } from '../registry.js';

const INTERVAL_GUIDANCE = 'Choose interval_seconds based on task difficulty and recovery urgency: critical core service/gateway/billing 5-30s; high long-running task/data sync/batch/reasoning 30-60s; medium cleanup/backup/report 60-120s; low-risk routine check 120-300s. Use a shorter interval when faster detection matters; the value must remain in seconds.';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nextRun(scheduler: CronScheduler, job: CronJob): string | null {
  return job.enabled ? scheduler.next(job)?.toISOString() ?? null : null;
}

export function createWatchdogTools(store: CronJobStore, scheduler: CronScheduler): ToolSpec[] {
  const latestRun = async (jobId: string) => (await scheduler.ledger.list(jobId, 1))[0] ?? null;
  const watchdogs = async () => (await store.list()).filter((job) => job.kind === 'script');

  return [
    {
      name: 'watchdog_register',
      description: `Create or update a persistent script watchdog. The health-check script follows watchdog semantics: exit 0 with empty stdout is a silent healthy result; nonzero exit is unhealthy and raises an alarm. This tool only checks and reports; it does not restart the target unless the supplied script does so. ${INTERVAL_GUIDANCE}`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique task name, for example gateway-8688 or data-sync-daily.' },
          script: { type: 'string', description: 'Shell health-check script. Nonzero exit means unhealthy; empty stdout means silent OK.' },
          interval_seconds: { type: 'number', description: `Positive whole-second interval selected by the AI. ${INTERVAL_GUIDANCE}` },
          timeout_seconds: { type: 'number', description: 'Positive whole-second check timeout. Defaults to 30.' },
          enabled: { type: 'boolean', description: 'Whether the watchdog is active. Defaults to true.' },
        },
        required: ['name', 'script', 'interval_seconds'], additionalProperties: false,
      },
      async execute(args) {
        const name = requiredString(args.name, 'name');
        const script = requiredString(args.script, 'script');
        const intervalSeconds = positiveInteger(args.interval_seconds, 'interval_seconds');
        const timeoutSeconds = args.timeout_seconds === undefined ? 30 : positiveInteger(args.timeout_seconds, 'timeout_seconds');
        if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new Error('enabled must be a boolean');
        const existing = (await store.list()).find((job) => job.name === name);
        const patch = {
          name, kind: 'script' as const, script, schedule: `every ${intervalSeconds}s`, at: undefined,
          timeout: timeoutSeconds * 1_000, enabled: args.enabled === undefined ? true : args.enabled,
          prompt: undefined, command: undefined,
        };
        const job = existing ? await store.update(existing.id, patch) : await store.add({
          ...patch, overlapPolicy: 'skip', misfirePolicy: 'skip', delivery: { type: 'console' },
        });
        if (!job) throw new Error(`Failed to update watchdog: ${name}`);
        await scheduler.reload();
        return { id: job.id, name: job.name, schedule: job.schedule, enabled: job.enabled, nextRun: nextRun(scheduler, job) };
      },
    },
    {
      name: 'watchdog_list',
      description: 'List all persistent script watchdogs with interval, enabled state, latest durable run result, and next run time. Administrator only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return Promise.all((await watchdogs()).map(async (job) => ({
          id: job.id, name: job.name, interval: job.schedule, enabled: job.enabled,
          lastScheduledAt: job.lastScheduledAt ?? null, lastResult: await latestRun(job.id), nextRun: nextRun(scheduler, job),
        })));
      },
    },
    {
      name: 'watchdog_remove',
      description: 'Remove a persistent script watchdog by its unique task name. Administrator only.',
      parameters: {
        type: 'object', properties: { name: { type: 'string', description: 'Unique watchdog task name.' } },
        required: ['name'], additionalProperties: false,
      },
      async execute(args) {
        const name = requiredString(args.name, 'name');
        const job = (await watchdogs()).find((item) => item.name === name);
        if (!job) return { removed: false, name };
        const removed = await store.remove(job.id);
        if (removed) await scheduler.reload();
        return { removed, id: job.id, name };
      },
    },
    {
      name: 'watchdog_status',
      description: 'Get one persistent script watchdog state, latest durable output/error, retries, and next run time. Administrator only.',
      parameters: {
        type: 'object', properties: { name: { type: 'string', description: 'Unique watchdog task name.' } },
        required: ['name'], additionalProperties: false,
      },
      async execute(args) {
        const name = requiredString(args.name, 'name');
        const job = (await watchdogs()).find((item) => item.name === name);
        if (!job) return { error: `Watchdog not found: ${name}` };
        return {
          id: job.id, name: job.name, enabled: job.enabled, schedule: job.schedule,
          timeoutSeconds: job.timeout / 1_000, lastScheduledAt: job.lastScheduledAt ?? null,
          lastResult: await latestRun(job.id), retries: job.retries, retryDelayMs: job.retryDelay,
          nextRun: nextRun(scheduler, job),
        };
      },
    },
  ];
}
