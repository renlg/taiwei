import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { guestIdForUsername } from '../util/paths.js';
import type { TaiweiConfig } from '../config/config.js';
import { resolveWorkspaceDir } from '../config/config.js';
import { MemoryStore } from '../memory/store.js';
import { FolderStore, guestFolderName, workspaceFolderMetadata } from './folders.js';
import { tenantWorkspaceForGuest } from './tenant-os.js';
import { SessionStore, type SessionIdentity } from './sessions.js';
import type { GatewayRuntime } from './runtime.js';
import { constantTimeEqual, json, openAiError, requestApiKey, requestShareToken, requestToken } from './http.js';
import { guestIdForShareToken, guestRouteAllowed, legacyGuestIdForShareToken, legacyGuestIdForUsername, publicApiRouteAllowed } from './guests.js';

export interface AuthenticatedRequest {
  token?: string;
  username?: string;
  role: 'admin' | 'guest';
  viaApiKey: boolean;
  guestId?: string;
}

/**
 * Authenticates an API request. Returns undefined when the response has already
 * been written (401/403). Requests that do not require auth receive the default
 * admin identity, matching the pre-refactor behavior.
 */
export async function authenticateRequest(
  runtime: GatewayRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  accessConfig: TaiweiConfig,
  method: string,
  pathname: string,
): Promise<AuthenticatedRequest | undefined> {
  const openAiRoute = pathname.startsWith('/v1/');
  const authRequired = (pathname.startsWith('/api/') && !publicApiRouteAllowed(method, pathname)) || openAiRoute;
  if (!authRequired) return { role: 'admin', viaApiKey: false };
  let authenticatedToken: string | undefined;
  let authenticatedUsername: string | undefined;
  let authenticatedRole: 'admin' | 'guest' = 'admin';
  let authenticatedViaApiKey = false;
  let guestId: string | undefined;
  authenticatedToken = requestToken(request);
  const authenticated = authenticatedToken ? await runtime.authSessions.authenticate(authenticatedToken) : undefined;
  if (authenticated) {
    authenticatedUsername = authenticated.username;
    authenticatedRole = authenticated.role ?? 'admin';
    if (authenticatedRole === 'guest') {
      guestId = guestIdForUsername(authenticated.username);
      await runtime.migrateLegacyGuestStorage(legacyGuestIdForUsername(authenticated.username), guestId);
    }
  } else {
    // Bearer credentials reach API-key verification only after login-session authentication fails.
    // A legacy share token may also use Bearer, so it remains the final fallback for Bearer only;
    // an explicitly invalid X-API-Key always fails closed.
    const apiKeyCandidate = requestApiKey(request);
    const apiKey = apiKeyCandidate ? await runtime.apiKeyStore.verify(apiKeyCandidate) : undefined;
    if (apiKey) {
      authenticatedRole = 'admin';
      authenticatedUsername = `api:${apiKey.name}`;
      authenticatedViaApiKey = true;
      authenticatedToken = undefined;
    } else {
      const explicitApiKeyHeader = request.headers['x-api-key'];
      const hasExplicitApiKey = (Array.isArray(explicitApiKeyHeader) ? explicitApiKeyHeader[0] : explicitApiKeyHeader)?.trim();
      const shareToken = hasExplicitApiKey ? undefined : requestShareToken(request) ?? authenticatedToken;
      if (accessConfig.share.enabled && shareToken && constantTimeEqual(shareToken, accessConfig.share.token)) {
        authenticatedRole = 'guest';
        authenticatedUsername = '访客';
        guestId = guestIdForShareToken(shareToken);
        await runtime.migrateLegacyGuestStorage(legacyGuestIdForShareToken(shareToken), guestId);
        authenticatedToken = undefined;
      } else {
        if (openAiRoute) openAiError(response, 401, apiKeyCandidate ? 'Invalid authentication credentials' : 'Missing authentication credentials', 'authentication_error');
        else json(response, 401, { error: 'unauthorized' });
        return undefined;
      }
    }
  }
  if (authenticatedRole === 'guest' && !guestRouteAllowed(method, pathname)) {
    if (openAiRoute) openAiError(response, 403, 'This endpoint requires administrator access', 'forbidden');
    else json(response, 403, { error: 'forbidden' });
    return undefined;
  }
  return {
    token: authenticatedToken,
    username: authenticatedUsername,
    role: authenticatedRole,
    viaApiKey: authenticatedViaApiKey,
    guestId,
  };
}

export interface RequestScope {
  accessConfig: TaiweiConfig;
  auth: AuthenticatedRequest;
  activeSessions: SessionStore;
  requestIdentityUsername: string;
  folderIdentity: { role: 'admin' | 'guest'; guestId?: string; username?: string; config: TaiweiConfig };
  activeFolders: FolderStore;
  guestWorkspace?: string;
  legacyGuestWorkspace?: string;
  guestFoldersFile?: string;
  turnMemory?: MemoryStore;
  deploymentIdentity(): Promise<string>;
  deploymentWorkspaceDirectories(): Promise<string[]>;
  deploymentGuestProjectsRoots(): Promise<string[]>;
}

export async function buildRequestScope(
  runtime: GatewayRuntime,
  auth: AuthenticatedRequest,
  accessConfig: TaiweiConfig,
  sessionIdentity: (role: 'admin' | 'guest', username: string) => Promise<SessionIdentity>,
): Promise<RequestScope> {
  const { log, taiweiPaths, tenantAccounts, configState, options } = runtime;
  const { guestId, role: authenticatedRole, username: authenticatedUsername, token: authenticatedToken } = auth;
  const activeSessions = guestId
    ? SessionStore.forGuest(guestId)
    : runtime.sessions;
  const requestIdentityUsername = authenticatedRole === 'admin'
    ? 'admin'
    : authenticatedToken
      ? authenticatedUsername ?? guestId ?? 'guest'
      : guestId ?? authenticatedUsername ?? 'guest';
  const folderIdentity = { role: authenticatedRole, ...(guestId ? { guestId } : {}), ...(authenticatedUsername ? { username: authenticatedUsername } : {}), config: accessConfig };
  const legacyGuestWorkspace = guestId ? join(taiweiPaths.guests, guestId, 'workspace') : undefined;
  const guestFoldersFile = guestId ? join(taiweiPaths.guests, guestId, 'folders.json') : undefined;
  const guestWorkspace = guestId && authenticatedToken && authenticatedUsername && tenantAccounts && legacyGuestWorkspace
    ? await (runtime.guestWorkspaceCache.get(authenticatedUsername) ?? (() => {
          const pending = tenantWorkspaceForGuest(authenticatedUsername, legacyGuestWorkspace, tenantAccounts.store, {
            homeRoot: options.tenantHomeRoot, foldersFile: guestFoldersFile, warn: log,
          });
          runtime.guestWorkspaceCache.set(authenticatedUsername, pending);
          return pending;
        })())
    : legacyGuestWorkspace;
  const adminWorkspace = resolveWorkspaceDir(accessConfig);
  const adminDefault = workspaceFolderMetadata(adminWorkspace);
  const activeFolders = options.folderStoreFactory?.(folderIdentity) ?? (guestId
    ? new FolderStore({
        file: guestFoldersFile!,
        owner: 'guest',
        rootPath: guestWorkspace!,
        defaultId: 'guest-default',
        defaultName: guestFolderName(authenticatedUsername ?? '访客'),
        defaultDirName: guestFolderName(authenticatedUsername ?? '访客'),
        defaultPath: () => guestWorkspace!,
        maxProjects: 9,
      })
    : new FolderStore({
        file: taiweiPaths.folders,
        owner: 'admin',
        rootPath: join(taiweiPaths.workspaces, 'admin'),
        defaultId: 'admin-default',
        defaultName: adminDefault.name,
        defaultDirName: adminDefault.dirName,
        defaultPath: async () => resolveWorkspaceDir(await configState.load()),
      }));
  const turnMemory = guestId ? MemoryStore.forGuest(guestId) : undefined;
  const deploymentIdentity = async () => {
    const tenantIdentity = await sessionIdentity(authenticatedRole, requestIdentityUsername);
    const identity = (tenantIdentity.osUsername ?? requestIdentityUsername).trim();
    return createHash('sha256').update(identity).digest('hex').slice(0, 8);
  };
  const deploymentWorkspaceDirectories = async () => (await activeFolders.list()).map((folder) => folder.path);
  const deploymentGuestProjectsRoots = async (): Promise<string[]> => {
    if (!tenantAccounts) return [];
    try {
      const accounts = await tenantAccounts.store.listAccounts();
      const filteredAccounts = authenticatedRole === 'guest'
        ? accounts.filter((account) => Boolean(authenticatedUsername) && account.username === authenticatedUsername)
        : accounts;
      return filteredAccounts
        .map((account) => join(options.tenantHomeRoot ?? '/home', account.osUsername, 'projects'))
        .filter((directory) => directory !== join(taiweiPaths.home, 'projects'));
    } catch (error) {
      log(`[taiwei] could not enumerate tenant accounts for deployment directory validation: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };
  return {
    accessConfig,
    auth,
    activeSessions,
    requestIdentityUsername,
    folderIdentity,
    activeFolders,
    guestWorkspace,
    legacyGuestWorkspace,
    guestFoldersFile,
    turnMemory,
    deploymentIdentity,
    deploymentWorkspaceDirectories,
    deploymentGuestProjectsRoots,
  };
}
