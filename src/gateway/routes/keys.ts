import type { ApiKeyRecord } from '../api-keys.js';
import { HttpError, json, readJson } from '../http.js';
import type { EarlyRouteContext } from './route-context.js';

function publicApiKeyRecord({ hash: _hash, ...record }: ApiKeyRecord): Omit<ApiKeyRecord, 'hash'> {
  return record;
}

/** Handles /api/keys CRUD (admin only). Runs before the request scope is built. */
export async function handleApiKeyRoutes(ctx: EarlyRouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname, auth } = ctx;
  if (!pathname.startsWith('/api/keys')) return false;
  const { apiKeyStore } = runtime;
  if (!auth) throw new HttpError(401, 'unauthorized');
  if (method === 'GET' && pathname === '/api/keys') {
    if (auth.role === 'guest') throw new HttpError(403, 'forbidden');
    json(response, 200, { keys: (await apiKeyStore.list()).map(publicApiKeyRecord) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/keys') {
    if (auth.role === 'guest') throw new HttpError(403, 'forbidden');
    const body = await readJson(request) as { name?: unknown; expiresInDays?: unknown };
    if (body.name !== undefined && typeof body.name !== 'string') throw new HttpError(400, 'name must be a string');
    if (body.expiresInDays !== undefined && (!Number.isInteger(body.expiresInDays) || (body.expiresInDays as number) <= 0)) {
      throw new HttpError(400, 'expiresInDays must be a positive integer');
    }
    const created = await apiKeyStore.create(body.name as string | undefined, body.expiresInDays as number | undefined);
    json(response, 201, { ok: true, record: publicApiKeyRecord(created.record), key: created.key });
    return true;
  }
  const apiKeyRoute = pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (method === 'DELETE' && (apiKeyRoute || pathname === '/api/keys')) {
    if (auth.role === 'guest') throw new HttpError(403, 'forbidden');
    let id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id')?.trim() ?? '';
    if (apiKeyRoute) {
      try { id = decodeURIComponent(apiKeyRoute[1]); }
      catch { throw new HttpError(400, 'Invalid API key id'); }
    } else if (!id) {
      const body = await readJson(request).catch(() => ({})) as { id?: unknown };
      if (typeof body.id === 'string') id = body.id.trim();
    }
    if (!id) throw new HttpError(400, 'id is required');
    json(response, 200, { ok: true, revoked: await apiKeyStore.revoke(id) });
    return true;
  }
  return false;
}
