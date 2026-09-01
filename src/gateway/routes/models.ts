import { applyDefaultProvider, managedProvider, publicProvider } from '../../config/model.js';
import { getAgentProfile, getAgentProfiles } from '../../agents/profiles.js';
import { HttpError, json, readJson } from '../http.js';
import { catalogForRole, grantedModelsFor, modelAllowedForRole, modelForSelection, validateModelGrants } from '../models-policy.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/models, /api/model-grants, /api/admin/models*, /api/agents, /api/agent, and /api/model. */
export async function handleModelRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname, scope } = ctx;
  const { modelState, configState, contextWindowFor, sessionIdentity } = runtime;
  const { auth, activeSessions, activeFolders, requestIdentityUsername } = scope;

  if (method === 'GET' && pathname === '/api/models') {
    const grants = grantedModelsFor(await configState.load(), requestIdentityUsername);
    const listed = catalogForRole(await modelState.resolveModels(), auth.role, grants);
    json(response, 200, { models: listed.models, current: listed.current, currentProvider: listed.currentProvider, providers: listed.providers });
    return true;
  }
  if (method === 'GET' && pathname === '/api/model-grants') {
    const config = await configState.load();
    json(response, 200, { grants: config.modelGrants ?? {} });
    return true;
  }
  if (method === 'POST' && pathname === '/api/model-grants') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'grants')) {
      throw new HttpError(400, '请求体必须包含 grants');
    }
    const config = await configState.load();
    config.modelGrants = validateModelGrants((body as { grants?: unknown }).grants, config);
    await configState.save(config);
    json(response, 200, { grants: config.modelGrants });
    return true;
  }
  if (method === 'GET' && pathname === '/api/admin/models') {
    const config = await configState.load();
    json(response, 200, { defaultProvider: config.defaultProvider, providers: config.providers.map(publicProvider) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/admin/models') {
    const body = await readJson(request) as Record<string, unknown>;
    const config = await configState.load();
    const input = body.provider && typeof body.provider === 'object' ? body.provider : body;
    const inputId = typeof (input as { id?: unknown }).id === 'string' ? (input as { id: string }).id.trim() : '';
    const index = config.providers.findIndex((provider) => provider.id === inputId);
    const provider = managedProvider(input, index >= 0 ? config.providers[index] : undefined);
    if (index >= 0) config.providers[index] = provider;
    else config.providers.push(provider);
    const requestedDefault = typeof body.defaultProvider === 'string' && body.defaultProvider.trim()
      ? body.defaultProvider.trim() : config.defaultProvider;
    if (!config.providers.some((item) => item.id === requestedDefault)) throw new HttpError(400, `Unknown default provider: ${requestedDefault}`);
    if (requestedDefault !== config.defaultProvider) applyDefaultProvider(config, requestedDefault);
    else if (provider.id === config.defaultProvider) applyDefaultProvider(config, provider.id);
    await configState.save(config);
    json(response, index >= 0 ? 200 : 201, { defaultProvider: config.defaultProvider, providers: config.providers.map(publicProvider) });
    return true;
  }
  if (method === 'DELETE' && pathname === '/api/admin/models') {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const providerId = url.searchParams.get('provider')?.trim();
    const replacement = url.searchParams.get('defaultProvider')?.trim();
    if (!providerId) throw new HttpError(400, 'provider is required');
    const config = await configState.load();
    if (!config.providers.some((provider) => provider.id === providerId)) throw new HttpError(404, 'Provider not found');
    if (providerId === config.defaultProvider && !replacement) throw new HttpError(400, 'Cannot delete the defaultProvider without choosing a new defaultProvider');
    const remaining = config.providers.filter((provider) => provider.id !== providerId);
    if (!remaining.length) throw new HttpError(400, 'Cannot delete the only provider');
    config.providers = remaining;
    if (providerId === config.defaultProvider) applyDefaultProvider(config, replacement!);
    else if (replacement) applyDefaultProvider(config, replacement);
    await configState.save(config);
    json(response, 200, { defaultProvider: config.defaultProvider, providers: config.providers.map(publicProvider) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/admin/models/reload') {
    const config = await configState.load();
    json(response, 200, { defaultProvider: config.defaultProvider, providers: config.providers.map(publicProvider) });
    return true;
  }
  if (method === 'GET' && pathname === '/api/agents') {
    json(response, 200, { agents: getAgentProfiles().map(({ id, mode }) => ({ id, mode })) }); return true;
  }
  if (method === 'POST' && pathname === '/api/agent') {
    const body = await readJson(request) as { sessionId?: unknown; agentId?: unknown };
    if (typeof body.sessionId !== 'string' || typeof body.agentId !== 'string') throw new HttpError(400, 'sessionId and agentId are required');
    getAgentProfile(body.agentId);
    const session = await activeSessions.get(body.sessionId);
    if (!session) throw new HttpError(404, 'Session not found');
    session.agentId = body.agentId; session.updatedAt = new Date().toISOString(); await activeSessions.save(session);
    json(response, 200, { ok: true, agentId: body.agentId }); return true;
  }
  if (method === 'GET' && pathname === '/api/model') {
    const sessionId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('sessionId');
    const session = sessionId ? await activeSessions.get(sessionId) : undefined;
    json(response, 200, { current: session?.currentModel ?? await modelState.getCurrentModel(), provider: session?.providerId });
    return true;
  }
  if (method === 'POST' && pathname === '/api/model') {
    const body = await readJson(request) as { model?: unknown; provider?: unknown; sessionId?: unknown };
    if (typeof body?.model !== 'string' || !body.model.trim()) {
      json(response, 400, { error: 'model must be a non-empty string' });
      return true;
    }
    const model = body.model.trim();
    const listed = await modelState.resolveModels();
    const provider = typeof body.provider === 'string' ? body.provider.trim() : listed.currentProvider;
    const selectedProvider = listed.providers?.find((item) => item.id === provider);
    const selectedModel = modelForSelection(listed, provider, model);
    const known = selectedProvider ? Boolean(selectedModel) : listed.models.includes(model);
    const grantedModels = grantedModelsFor(await configState.load(), requestIdentityUsername);
    if (!modelAllowedForRole(auth.role, selectedProvider, model, grantedModels)) {
      throw new HttpError(403, `${auth.role === 'guest' ? 'Guest' : 'This account'} cannot select this model`);
    }
    if (!known && listed.source !== 'fallback') {
      json(response, 400, { error: `Unknown model: ${model}`, models: listed.models });
      return true;
    }
    let targetSessionId = body.sessionId;
    if (auth.role === 'guest' && targetSessionId === undefined) {
      const latest = (await activeSessions.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (latest) targetSessionId = latest.id;
      else {
        const created = await activeSessions.create(
          'build', (await activeFolders.defaultFolder()).id, undefined, undefined,
          await sessionIdentity(auth.role, requestIdentityUsername),
        );
        targetSessionId = created.id;
      }
    }
    if (targetSessionId !== undefined) {
      if (typeof targetSessionId !== 'string') throw new HttpError(400, 'sessionId must be a string');
      const session = await activeSessions.get(targetSessionId);
      if (!session) throw new HttpError(404, 'Session not found');
      session.currentModel = model; session.providerId = provider; session.updatedAt = new Date().toISOString();
      await activeSessions.save(session);
    } else await modelState.setCurrentModel(model);
    json(response, 200, {
      ok: true, current: model, provider,
      ...(auth.role === 'guest' && targetSessionId ? { sessionId: targetSessionId } : {}),
      contextWindow: selectedProvider?.models.find((item) => item.id === model)?.capabilities.contextWindow ?? await contextWindowFor(model),
    });
    return true;
  }
  return false;
}
