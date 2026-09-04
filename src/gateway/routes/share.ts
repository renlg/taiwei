import { json } from '../http.js';
import { sharedSessionView } from '../guests.js';
import type { EarlyRouteContext } from './route-context.js';

/** Serves a single token-scoped, read-only session without authentication. */
export async function handlePublicShareRoute(ctx: EarlyRouteContext): Promise<boolean> {
  const match = ctx.pathname.match(/^\/api\/share\/([^/]+)$/);
  if (ctx.method !== 'GET' || !match) return false;
  let token = '';
  try { token = decodeURIComponent(match[1]); }
  catch { /* Invalid encoded tokens are indistinguishable from unknown tokens. */ }
  const shared = token ? await ctx.runtime.sessions.getSharedSession(token) : undefined;
  if (!shared) json(ctx.response, 404, { error: 'Shared session not found' });
  else json(ctx.response, 200, sharedSessionView(shared.session));
  return true;
}
