import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureTaiweiHome } from '../util/paths.js';

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
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
        if (!job.id || !job.name || !job.schedule || !job.prompt) throw new Error(`entry ${index} is missing required fields`);
        return { ...job, enabled: job.enabled !== false } as CronJob;
      });
    } catch (error) {
      throw new Error(`Invalid cron file: ${(error as Error).message}`);
    }
  }

  private async save(jobs: CronJob[]): Promise<void> {
    const { cron } = await ensureTaiweiHome();
    await writeFile(cron, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
  }

  async add(name: string, schedule: string, prompt: string): Promise<CronJob> {
    const jobs = await this.list();
    const job = { id: randomUUID().slice(0, 8), name, schedule, prompt, enabled: true };
    jobs.push(job); await this.save(jobs); return job;
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
