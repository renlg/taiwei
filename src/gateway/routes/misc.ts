import { resolveWorkspaceDir } from '../../config/config.js';
import { readAudit } from '../../observability/audit.js';
import { json, HttpError, readJson } from '../http.js';
import type { RouteContext } from './route-context.js';

/** Handles GET /api/info. */
export async function handleInfo(ctx: RouteContext): Promise<boolean> {
  const { runtime, response, method, pathname, scope } = ctx;
  if (method !== 'GET' || pathname !== '/api/info') return false;
  const model = await runtime.modelState.getCurrentModel();
  const config = await runtime.configState.load();
  json(response, 200, {
    model,
    contextWindow: await runtime.contextWindowFor(model),
    authEnabled: scope.accessConfig.auth.enabled,
    role: scope.auth.role,
    workspace: resolveWorkspaceDir(config),
    ...(scope.auth.username ? { username: scope.auth.username } : {}),
  });
  return true;
}

/** Handles POST /api/confirm. */
export async function handleConfirm(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  if (method !== 'POST' || pathname !== '/api/confirm') return false;
  const body = await readJson(request) as { id?: unknown; approve?: unknown; remember?: unknown };
  if (typeof body.id !== 'string' || typeof body.approve !== 'boolean') throw new HttpError(400, 'id and approve are required');
  if (body.remember !== undefined && !['off', 'session', 'permanent'].includes(String(body.remember))) throw new HttpError(400, 'remember must be off, session, or permanent');
  if (!runtime.confirmations.decide(body.id, { approve: body.approve, ...(body.remember ? { remember: body.remember as 'off' | 'session' | 'permanent' } : {}) })) {
    throw new HttpError(404, 'Confirmation is no longer pending');
  }
  json(response, 200, { ok: true });
  return true;
}

/** Handles GET /api/audit (admin only). */
export async function handleAudit(ctx: RouteContext): Promise<boolean> {
  const { request, response, method, pathname } = ctx;
  if (method !== 'GET' || pathname !== '/api/audit') return false;
  const url = new URL(request.url ?? '/', 'http://localhost');
  json(response, 200, { entries: await readAudit(Number(url.searchParams.get('limit') ?? 100), Number(url.searchParams.get('offset') ?? 0)) });
  return true;
}
