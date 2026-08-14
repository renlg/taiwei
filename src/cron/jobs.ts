import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureTaiweiHome } from '../util/paths.js';

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
  async list(): Promise<CronJob[]> {
    const { cron } = await ensureTaiweiHome();
    try {
      const value = JSON.parse(await readFile(cron, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('root value must be an array');
      return value.map((item, index) => {
        if (!item || typeof item !== 'object') throw new Error(`entry ${index} must be an object`);
        const job = item as Partial<CronJob>;
        return normalized(job, index);
      });
    } catch (error) {
      throw new Error(`Invalid cron file: ${(error as Error).message}`);
    }
  }

  private async save(jobs: CronJob[]): Promise<void> {
    const { cron } = await ensureTaiweiHome();
    await writeFile(cron, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
  }

  async add(name: string, schedule: string, prompt: string): Promise<CronJob>;
  async add(input: CronJobInput): Promise<CronJob>;
  async add(nameOrInput: string | CronJobInput, schedule?: string, prompt?: string): Promise<CronJob> {
    const jobs = await this.list();
    const input = typeof nameOrInput === 'string' ? { name: nameOrInput, schedule, prompt, kind: 'agent' as const } : nameOrInput;
    const job = normalized({ id: randomUUID().slice(0, 8), ...input });
    jobs.push(job); await this.save(jobs); return job;
  }

  async update(id: string, patch: Partial<Omit<CronJob, 'id'>>): Promise<CronJob | undefined> {
    const jobs = await this.list();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return undefined;
    jobs[index] = normalized({ ...jobs[index], ...patch, id });
    await this.save(jobs); return jobs[index];
  }

  async remove(id: string): Promise<boolean> {
    const jobs = await this.list();
    const remaining = jobs.filter((job) => job.id !== id);
    if (remaining.length === jobs.length) return false;
    await this.save(remaining); return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const jobs = await this.list();
    const job = jobs.find((item) => item.id === id);
    if (!job) return false;
    job.enabled = enabled; await this.save(jobs); return true;
  }
}
