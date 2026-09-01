import { HttpError, json, readJson } from '../http.js';
import { guestPublicFolder, guestPublicSession } from '../guests.js';
import { grantedModelsFor, modelAllowedForRole, modelForSelection } from '../models-policy.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/sessions*, /api/folders*, and /api/stop routes. */
export async function handleSessionRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { options, pendingTurns, stopRequested, sessionIdentity, configState, modelState } = runtime;
  const { auth, activeSessions, activeFolders, requestIdentityUsername } = ctx.scope;
  const { role: authenticatedRole, guestId, username: authenticatedUsername } = auth;
  const runtimeSessionIdFor = (sessionId: string) => `${guestId ?? authenticatedUsername ?? authenticatedRole}:${sessionId}`;

  if (method === 'GET' && pathname === '/api/sessions') {
    const defaultFolder = await activeFolders.defaultFolder();
    json(response, 200, (await activeSessions.list()).map((session) => ({ ...session, folderId: session.folderId ?? defaultFolder.id })));
    return true;
  }
  if (method === 'POST' && pathname === '/api/sessions') {
    const body = await readJson(request).catch(() => ({})) as { folderId?: unknown; model?: unknown; provider?: unknown };
    if (body.folderId !== undefined && typeof body.folderId !== 'string') throw new HttpError(400, 'folderId must be a string');
    const folder = typeof body.folderId === 'string' ? await activeFolders.get(body.folderId) : await activeFolders.defaultFolder();
    if (!folder) throw new HttpError(404, 'Folder not found');
    let model: string | undefined;
    let provider: string | undefined;
    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || !body.model.trim()) throw new HttpError(400, 'model must be a non-empty string');
      model = body.model.trim();
      const listed = await modelState.resolveModels();
      provider = typeof body.provider === 'string' ? body.provider.trim() : listed.currentProvider;
      const selectedProvider = listed.providers?.find((item) => item.id === provider);
      const selectedModel = modelForSelection(listed, provider, model);
      const known = selectedProvider ? Boolean(selectedModel) : listed.models.includes(model);
      const grantedModels = grantedModelsFor(await configState.load(), requestIdentityUsername);
      if (!modelAllowedForRole(authenticatedRole, selectedProvider, model, grantedModels)) {
        throw new HttpError(403, `${authenticatedRole === 'guest' ? 'Guest' : 'This account'} cannot select this model`);
      }
      if (!known && listed.source !== 'fallback') throw new HttpError(400, `Unknown model: ${model}`);
    } else if (body.provider !== undefined) throw new HttpError(400, 'provider requires model');
    const existing = await activeSessions.findBlankSession(folder.id);
    if (existing) {
      if (!existing.identity || existing.identity.role !== authenticatedRole || existing.identity.username !== requestIdentityUsername) {
        existing.identity = await sessionIdentity(authenticatedRole, requestIdentityUsername);
        existing.updatedAt = new Date().toISOString();
        await activeSessions.save(existing);
      }
      json(response, 200, authenticatedRole === 'guest' ? guestPublicSession(existing) : existing);
      return true;
    }
    const created = await activeSessions.create(
      'build', folder.id, model, provider,
      await sessionIdentity(authenticatedRole, requestIdentityUsername),
    );
    json(response, 201, authenticatedRole === 'guest' ? guestPublicSession(created) : created);
    return true;
  }
  if (method === 'GET' && pathname === '/api/folders') {
    const folders = await activeFolders.list();
    json(response, 200, authenticatedRole === 'guest' ? folders.map(guestPublicFolder) : folders);
    return true;
  }
  if (method === 'POST' && pathname === '/api/folders') {
    const body = await readJson(request) as { name?: unknown; parentId?: unknown };
    if (body.parentId !== undefined && typeof body.parentId !== 'string') throw new HttpError(400, 'parentId must be a string');
    const folder = await activeFolders.create(body.name, body.parentId);
    json(response, 201, authenticatedRole === 'guest' ? guestPublicFolder(folder) : folder);
    return true;
  }
  const folderRoute = pathname.match(/^\/api\/folders\/([^/]+)$/);
  if (folderRoute && method === 'PATCH') {
    const id = decodeURIComponent(folderRoute[1]);
    const existing = await activeFolders.get(id);
    if (!existing) throw new HttpError(404, 'Folder not found');
    if (existing.system) throw new HttpError(403, 'System folders cannot be renamed');
    const body = await readJson(request) as { name?: unknown };
    const folder = await activeFolders.rename(id, body.name);
    json(response, 200, authenticatedRole === 'guest' && folder ? guestPublicFolder(folder) : folder);
    return true;
  }
  if (folderRoute && method === 'DELETE') {
    const id = decodeURIComponent(folderRoute[1]);
    const folders = await activeFolders.list();
    const folder = folders.find((item) => item.id === id);
    if (!folder) throw new HttpError(404, 'Folder not found');
    if (folder.system) throw new HttpError(403, 'System folders cannot be deleted');
    if (folders.some((item) => item.parentId === id)) throw new HttpError(409, 'Folder contains sub-folders');
    const destination = folders.find((item) => item.default)!;
    const movedSessions = await activeSessions.moveFolderSessions(id, destination.id);
    await activeFolders.delete(id);
    json(response, 200, { ok: true, movedSessions, destinationFolderId: destination.id });
    return true;
  }
  const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionRoute && method === 'GET') {
    const session = await activeSessions.get(decodeURIComponent(sessionRoute[1]));
    if (!session) json(response, 404, { error: 'Session not found' });
    else json(response, 200, authenticatedRole === 'guest' ? guestPublicSession(session) : session);
    return true;
  }
  if (sessionRoute && method === 'DELETE') {
    const deleted = await activeSessions.delete(decodeURIComponent(sessionRoute[1]));
    if (!deleted) json(response, 404, { error: 'Session not found' });
    else { response.writeHead(204); response.end(); }
    return true;
  }
  const pendingRoute = pathname.match(/^\/api\/sessions\/([^/]+)\/pending$/);
  if (pendingRoute && method === 'GET') {
    const sessionId = decodeURIComponent(pendingRoute[1]);
    const runtimeSessionId = runtimeSessionIdFor(sessionId);
    const pending = pendingTurns.get(runtimeSessionId);
    if (!pending) { json(response, 200, { running: false }); return true; }
    json(response, 200, {
      running: true,
      turnId: pending.turnId,
      answer: pending.answer,
      toolCalls: authenticatedRole === 'guest'
        ? pending.toolCalls
        : pending.toolCalls,
      usage: pending.usage,
    });
    return true;
  }
  if (method === 'POST' && pathname === '/api/stop') {
    const body = await readJson(request).catch(() => ({})) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const runtimeSessionId = runtimeSessionIdFor(sessionId);
    stopRequested.add(runtimeSessionId);
    json(response, 200, { stopped: sessionId ? options.chat.stop(runtimeSessionId) : false });
    return true;
  }
  return false;
}
