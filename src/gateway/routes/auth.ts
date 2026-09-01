import { hashPassword, isScryptPassword, verifyPassword } from '../../config/password.js';
import { HttpError, json, lockMessage, readJson, requestOrigin, safeInlineJson, sessionCookie, constantTimeEqual } from '../http.js';
import type { EarlyRouteContext, RouteContext } from './route-context.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
/** Upper bound for in-flight OAuth states; the endpoint is unauthenticated so this caps memory abuse. */
const MAX_OAUTH_STATES = 1_000;

function oauthProviderBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HttpError(503, 'OAuth providerBaseUrl is not configured'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(503, 'OAuth providerBaseUrl must use http or https');
  return url.toString().replace(/\/$/, '');
}

/** Handles public (pre-authentication) routes: /api/oauth/start, /api/oauth/callback, /api/login. */
export async function handlePublicAuthRoutes(ctx: EarlyRouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname, accessConfig } = ctx;
  const { log, oauthStates, authSessions, loginLocks, tenantAccounts, configState, options } = runtime;
  if (method === 'POST' && pathname === '/api/oauth/start') {
    if (!accessConfig.oauth.enabled) {
      json(response, 404, { error: 'OAuth login is disabled' });
      return true;
    }
    const body = await readJson(request) as { state?: unknown };
    const state = typeof body.state === 'string' ? body.state : '';
    if (!/^[a-f0-9]{32,128}$/i.test(state)) throw new HttpError(400, 'Invalid OAuth state');
    const now = Date.now();
    for (const [key, expiresAt] of oauthStates) if (expiresAt <= now) oauthStates.delete(key);
    if (oauthStates.size >= MAX_OAUTH_STATES) throw new HttpError(429, 'Too many pending OAuth states, please retry later');
    const expiresAt = now + OAUTH_STATE_TTL_MS;
    oauthStates.set(state, expiresAt);
    const redirectUri = accessConfig.oauth.redirectUri.trim() || `${requestOrigin(request, accessConfig)}/api/oauth/callback`;
    const authorizeUrl = new URL(`${oauthProviderBaseUrl(accessConfig.oauth.providerBaseUrl)}/api/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', accessConfig.oauth.clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', state);
    json(response, 200, { authorizeUrl: authorizeUrl.toString(), state, expiresAt: new Date(expiresAt).toISOString() });
    return true;
  }
  if (method === 'GET' && pathname === '/api/oauth/callback') {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const expiresAt = oauthStates.get(state);
    oauthStates.delete(state);
    if (!state || !expiresAt || expiresAt <= Date.now()) throw new HttpError(400, 'Invalid or expired OAuth state');
    if (!code) throw new HttpError(400, 'Missing OAuth authorization code');
    if (!accessConfig.oauth.enabled) throw new HttpError(400, 'OAuth login is disabled');
    const providerBaseUrl = oauthProviderBaseUrl(accessConfig.oauth.providerBaseUrl);
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(`${providerBaseUrl}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: accessConfig.oauth.clientId,
          client_secret: accessConfig.oauth.clientSecret,
          code,
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'oauth token exchange failed');
    }
    if (!tokenResponse.ok) throw new HttpError(tokenResponse.status === 400 || tokenResponse.status === 401 ? 401 : 502, 'oauth token exchange failed');
    const tokenBody = await tokenResponse.json().catch(() => undefined) as { access_token?: unknown } | undefined;
    if (typeof tokenBody?.access_token !== 'string' || !tokenBody.access_token) throw new HttpError(502, 'oauth token exchange failed');
    let userinfoResponse: Response;
    try {
      userinfoResponse = await fetch(`${providerBaseUrl}/api/oauth/userinfo`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
        signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'oauth userinfo failed');
    }
    if (!userinfoResponse.ok) throw new HttpError(502, 'oauth userinfo failed');
    const userinfo = await userinfoResponse.json().catch(() => undefined) as { username?: unknown } | undefined;
    const username = typeof userinfo?.username === 'string' ? userinfo.username.trim() : '';
    if (!username) throw new HttpError(502, 'oauth userinfo failed');
    if (tenantAccounts) {
      try { await tenantAccounts.ensureTenantAccount(username); }
      catch (error) { log(`[taiwei] tenant provisioning failed for ${username}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const token = await authSessions.create(username, 'guest');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录成功</title></head><body><p>登录成功，正在进入 taiwei…</p><script>localStorage.setItem('taiwei-token',${safeInlineJson(token)});localStorage.setItem('taiwei-role','guest');localStorage.setItem('taiwei-username',${safeInlineJson(username)});sessionStorage.removeItem('taiwei-oauth-state');sessionStorage.removeItem('taiwei-oauth-state-expires');window.location.replace('/');</script></body></html>`;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(token),
      'content-length': Buffer.byteLength(html),
    });
    response.end(html);
    return true;
  }
  if (method === 'POST' && pathname === '/api/login') {
    const authEnabled = accessConfig.auth.enabled;
    if (!authEnabled) {
      json(response, 404, { error: 'Authentication is disabled' });
      return true;
    }
    const body = await readJson(request) as { username?: unknown; password?: unknown };
    const ip = request.socket.remoteAddress ?? 'unknown';
    const attemptedUsername = typeof body?.username === 'string' ? body.username : '';
    const configuredPassword = options.authPasswordFromEnvironment
      ? options.auth?.password ?? ''
      : accessConfig.auth.password;
    const configuredUsername = accessConfig.auth.username;
    const adminValid = authEnabled && typeof body?.username === 'string'
      && typeof body?.password === 'string'
      && constantTimeEqual(body.username, configuredUsername)
      && verifyPassword(body.password, configuredPassword);
    const attempt = await loginLocks.attempt(attemptedUsername, ip, adminValid);
    if (attempt.lock) {
      log(`[taiwei] Warning: login lock ${attempt.lock} reached for ${ip} (${attemptedUsername || '<empty>'})`);
      json(response, 429, { error: lockMessage(attempt.lock) });
      return true;
    }
    if (attempt.failed) {
      json(response, 401, { error: 'Invalid username or password' });
      return true;
    }
    if (adminValid && !options.authPasswordFromEnvironment && !isScryptPassword(configuredPassword)) {
      const migratedPassword = hashPassword(body.password as string);
      const config = await configState.load();
      if (config.auth.password === configuredPassword) {
        config.auth.password = migratedPassword;
        await configState.save(config);
      }
      if (options.auth) options.auth.password = migratedPassword;
    }
    const username = body.username as string;
    const token = await authSessions.create(username, 'admin');
    json(response, 200, { token, role: 'admin', username }, { 'set-cookie': sessionCookie(token) });
    return true;
  }
  return false;
}

/** Handles POST /api/logout (requires authentication). */
export async function handleLogout(ctx: RouteContext): Promise<boolean> {
  if (ctx.method !== 'POST' || ctx.pathname !== '/api/logout') return false;
  const { runtime, response, scope } = ctx;
  if (scope.auth.token) await runtime.authSessions.delete(scope.auth.token);
  json(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  return true;
}
