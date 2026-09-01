import type { CronJobInput } from '../../cron/jobs.js';
import { jobNextRun } from '../../cron/scheduler.js';
import { HttpError, json, readJson } from '../http.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/cron* routes. */
export async function handleCronRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { options } = runtime;
  if (!pathname.startsWith('/api/cron')) return false;

  if (method === 'GET' && pathname === '/api/cron') {
    if (!options.cronJobs || !options.cronScheduler) throw new HttpError(503, 'Cron scheduler is unavailable');
    const jobs = await options.cronJobs.list();
    json(response, 200, { jobs: jobs.map((job) => ({ ...job, nextRun: job.enabled ? jobNextRun(job)?.toISOString() : undefined, lastRuns: options.cronScheduler!.ledger.lastRuns(job.id) })) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/cron') {
    if (!options.cronJobs || !options.cronScheduler) throw new HttpError(503, 'Cron scheduler is unavailable');
    const body = await readJson(request) as CronJobInput & { id?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
    const job = typeof body.id === 'string'
      ? await options.cronJobs.update(body.id, body)
      : await options.cronJobs.add(body);
    if (!job) throw new HttpError(404, 'Cron job not found');
    await options.cronScheduler.reload(); json(response, typeof body.id === 'string' ? 200 : 201, job); return true;
  }
  if (method === 'DELETE' && pathname === '/api/cron') {
    if (!options.cronJobs || !options.cronScheduler) throw new HttpError(503, 'Cron scheduler is unavailable');
    const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id');
    if (!id) throw new HttpError(400, 'id is required');
    if (!await options.cronJobs.remove(id)) throw new HttpError(404, 'Cron job not found');
    await options.cronScheduler.reload(); json(response, 200, { ok: true }); return true;
  }
  const cronRunRoute = pathname.match(/^\/api\/cron\/([^/]+)\/run$/);
  if (method === 'POST' && cronRunRoute) {
    if (!options.cronScheduler) throw new HttpError(503, 'Cron scheduler is unavailable');
    json(response, 200, await options.cronScheduler.runNow(decodeURIComponent(cronRunRoute[1]))); return true;
  }
  if (method === 'GET' && pathname === '/api/cron/runs') {
    if (!options.cronScheduler) throw new HttpError(503, 'Cron scheduler is unavailable');
    const url = new URL(request.url ?? '/', 'http://localhost');
    json(response, 200, { runs: await options.cronScheduler.ledger.list(url.searchParams.get('jobId') ?? undefined, Number(url.searchParams.get('limit') ?? 100)) }); return true;
  }
  return false;
}
