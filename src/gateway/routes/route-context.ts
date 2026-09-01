import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TaiweiConfig } from '../../config/config.js';
import type { GatewayRuntime } from '../runtime.js';
import type { RequestScope, AuthenticatedRequest } from '../request-scope.js';

/** Context for routes that run before the per-request scope is built (OAuth/login, OpenAI compat, API keys). */
export interface EarlyRouteContext {
  runtime: GatewayRuntime;
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  pathname: string;
  accessConfig: TaiweiConfig;
  auth?: AuthenticatedRequest;
}

export interface RouteContext {
  runtime: GatewayRuntime;
  scope: RequestScope;
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  pathname: string;
  /** Holder for the SSE error-persistence callback used by the chat route and the top-level error handler. */
  sseErrorPersistence: { handler?: (error: Error) => Promise<void> };
}
