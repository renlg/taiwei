import { AuthSessionStore } from '../src/gateway/auth.js';

const TEST_ADMIN_TOKEN = 'taiwei-local-test-admin-token';
const marker = Symbol.for('taiwei.gateway-test-auth-installed');

/** Give legacy gateway tests an explicit trusted administrator credential. */
export function installGatewayTestAdminAuth(): void {
  const globals = globalThis as typeof globalThis & { [marker]?: boolean };
  if (globals[marker]) return;
  globals[marker] = true;

  const originalAuthenticate = AuthSessionStore.prototype.authenticate;
  AuthSessionStore.prototype.authenticate = async function authenticate(token: string) {
    if (token === TEST_ADMIN_TOKEN) {
      const now = new Date();
      return {
        username: 'admin', role: 'admin', createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      };
    }
    return originalAuthenticate.call(this, token);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url, 'http://localhost');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const hasShare = parsed.searchParams.has('share') || headers.has('x-share-token')
      || /(?:^|;\s*)taiwei_share_token=/.test(headers.get('cookie') ?? '');
    if (/^(?:127\.0\.0\.1|localhost)$/.test(parsed.hostname) && parsed.pathname.startsWith('/api/')
      && !headers.has('authorization') && !hasShare) {
      headers.set('authorization', `Bearer ${TEST_ADMIN_TOKEN}`);
    }
    return originalFetch(input, { ...init, headers });
  };
}

export const invalidGatewayAuthHeader = { authorization: 'Bearer intentionally-invalid-test-token' };
