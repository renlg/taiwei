// Gateway server assembly + dispatch layer.
//
// The gateway implementation is split across focused modules:
// - runtime.ts          service-level shared state (stores, caches, helpers)
// - request-scope.ts    authentication + per-request scope construction
// - http.ts / sse.ts    response/request primitives
// - routes/*            route handlers grouped by domain
// This file only wires them together in the original dispatch order.
import { createServer, type Server } from 'node:http';
import { createGatewayRuntime, type GatewayServerOptions } from './runtime.js';
import { authenticateRequest, buildRequestScope } from './request-scope.js';
import { HttpError, json, openAiError, openAiSse, type OpenAiErrorType } from './http.js';
import { sendSse } from './sse.js';
import { handlePublicAuthRoutes, handleLogout } from './routes/auth.js';
import { handleOpenAiRoutes } from './routes/openai.js';
import { handleApiKeyRoutes } from './routes/keys.js';
import { handleInfo, handleConfirm, handleAudit } from './routes/misc.js';
import { handleDeploymentRoutes } from './routes/deployments.js';
import { handleSettingsRoutes } from './routes/settings.js';
import { handleMcpRoutes } from './routes/mcp.js';
import { handleSkillRoutes } from './routes/skills.js';
import { handleToolRoutes } from './routes/tools.js';
import { handleKnowledgeRoutes } from './routes/knowledge.js';
import { handleModelRoutes } from './routes/models.js';
import { handleCronRoutes } from './routes/cron.js';
import { handleSessionRoutes } from './routes/sessions.js';
import { handleUploadRoute } from './routes/upload.js';
import { handleChatRoute } from './routes/chat.js';
import { handleStaticRoutes } from './routes/static.js';
import { handlePublicShareRoute } from './routes/share.js';

// Public API surface preserved from the pre-split server.ts.
export type { GatewayHistoryIndex, GatewayModelState, GatewayServerOptions } from './runtime.js';
export { formatGatewayTurnError } from './openai-format.js';
export { modelAllowedForRole } from './models-policy.js';
export { guestIdForUsername } from '../util/paths.js';
export { guestIdForShareToken, publicApiRouteAllowed, guestRouteAllowed } from './guests.js';
export { attachmentContext, attachmentGenerationInstructions, buildMultimodalContent } from './attachments.js';

export function createGatewayServer(options: GatewayServerOptions): Server {
  const runtime = createGatewayRuntime(options);
  const { log, configState } = runtime;
  const server = createServer(async (request, response) => {
    await runtime.startupCleanup;
    const started = Date.now();
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const sseErrorPersistence: { handler?: (error: Error) => Promise<void> } = {};
    response.once('finish', () => log(`[taiwei] ${method} ${pathname} ${response.statusCode} ${Date.now() - started}ms`));
    try {
      if (method === 'GET' && pathname === '/api/health') {
        json(response, 200, { ok: true });
        return;
      }
      const accessConfig = await configState.load();
      const earlyContext = { runtime, request, response, method, pathname, accessConfig };
      // Token-scoped shared sessions are public and read-only.
      if (await handlePublicShareRoute(earlyContext)) return;
      // Public authentication routes (OAuth start/callback, local login).
      if (await handlePublicAuthRoutes(earlyContext)) return;
      // Authentication middleware: writes the 401/403 response itself when it fails.
      const auth = await authenticateRequest(runtime, request, response, accessConfig, method, pathname);
      if (!auth) return;
      // OpenAI-compatible endpoints and API-key management run before the
      // per-request scope is built, matching the original dispatch order.
      if (await handleOpenAiRoutes({ ...earlyContext, auth })) return;
      if (await handleApiKeyRoutes({ ...earlyContext, auth })) return;
      const scope = await buildRequestScope(runtime, auth, accessConfig, runtime.sessionIdentity);
      const routeContext = { runtime, scope, request, response, method, pathname, sseErrorPersistence };
      if (await handleLogout(routeContext)) return;
      if (await handleInfo(routeContext)) return;
      if (await handleDeploymentRoutes(routeContext)) return;
      if (await handleSettingsRoutes(routeContext)) return;
      if (await handleMcpRoutes(routeContext)) return;
      if (await handleSkillRoutes(routeContext)) return;
      if (await handleToolRoutes(routeContext)) return;
      if (await handleKnowledgeRoutes(routeContext)) return;
      if (await handleConfirm(routeContext)) return;
      if (await handleModelRoutes(routeContext)) return;
      if (await handleCronRoutes(routeContext)) return;
      if (await handleSessionRoutes(routeContext)) return;
      if (await handleAudit(routeContext)) return;
      if (await handleUploadRoute(routeContext)) return;
      if (await handleChatRoute(routeContext)) return;
      // Static files, then the terminal 404.
      if (await handleStaticRoutes(routeContext)) return;
    } catch (error) {
      if (!response.headersSent) {
        if (pathname.startsWith('/v1/')) {
          const status = error instanceof HttpError ? error.status : 500;
          const type: OpenAiErrorType = status === 401 ? 'authentication_error'
            : status === 403 ? 'forbidden'
              : status >= 500 ? 'server_error'
                : 'invalid_request_error';
          openAiError(response, status, (error as Error).message, type);
        } else {
          json(response, error instanceof HttpError ? error.status : 400, { error: (error as Error).message });
        }
      } else {
        const routeError = error instanceof Error ? error : new Error(String(error));
        if (sseErrorPersistence.handler) {
          try { await sseErrorPersistence.handler(routeError); }
          catch (saveError) {
            log(`[taiwei] failed to persist SSE route error: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
          }
        }
        if (pathname.startsWith('/v1/')) {
          openAiSse(response, { error: { message: routeError.message, type: 'server_error', code: null } });
          openAiSse(response, '[DONE]');
        } else {
          sendSse(response, 'error', { message: routeError.message });
        }
        response.end();
      }
    }
  });
  server.once('close', () => {
    if (runtime.tenantAccounts) runtime.tenantAccounts.store.close?.();
    runtime.deployments.close?.();
  });
  return server;
}

export async function listenGateway(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind to a TCP port');
  return address.port;
}

export async function closeGateway(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
