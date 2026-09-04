import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ChatBridge } from './chat.js';
import { AuthSessionStore } from './auth.js';
import { ApiKeyStore } from './api-keys.js';
import { LoginLockStore } from './login-locks.js';
import { SessionStore, type SessionIdentity, type SessionUsage, type SessionToolCall } from './sessions.js';
import { FolderStore, guestFolderName, workspaceFolderMetadata, type GatewayFolder } from './folders.js';
import { getCurrentModel, resolveModelCatalog, setCurrentModel, type ModelListResult } from '../config/model.js';
import { authPasswordHasEnvironmentTemplate, loadConfig, resolveContextWindow, resolveToolSettings, resolveWorkspaceDir, saveConfig, type TaiweiConfig } from '../config/config.js';
import { getPaths } from '../util/paths.js';
import { ConfirmationBroker } from './confirmations.js';
import type { HookRunner } from '../hooks/runner.js';
import { SkillLoader, type Skill } from '../skills/loader.js';
import { buildIndex, type RagIndexData } from '../rag/index.js';
import { retrieve, type SearchResult } from '../rag/retrieve.js';
import { createEmbedder } from '../rag/embedding.js';
import { loadMcpConfig, type McpServerConfig } from '../mcp/client.js';
import { ToolRegistry } from '../tools/registry.js';
import { UserSkillStore } from '../skills/user-store.js';
import { UserSkillStateStore } from '../skills/user-state.js';
import { appendMessage as appendHistoryMessage, upsertSession as upsertHistorySession, type HistoryMessageInput, type HistorySessionMeta } from '../history/db.js';
import { MemoryStore } from '../memory/store.js';
import { fileURLToPath } from 'node:url';
import { CronJobStore, type CronJobInput } from '../cron/jobs.js';
import { CronScheduler } from '../cron/scheduler.js';
import type { PluginLoader } from '../plugins/loader.js';
import { uploadToOss } from './oss.js';
import { TenantAccountService, TenantAccountStore } from './tenants.js';
import { publicMcpServer } from './mcp-config.js';
import type { ToolConfigSchema } from '../tools/registry.js';
import { HttpError } from './http.js';
import type { DeploymentRecord, DeploymentRepository, CleanupStep, DeploymentDoctorResult } from './deployments.js';
import { DeploymentStore } from './deployments.js';

export interface GatewayHistoryIndex {
  upsertSession(meta: HistorySessionMeta): Promise<void>;
  appendMessage(message: HistoryMessageInput): Promise<unknown>;
}

export interface GatewayModelState {
  getCurrentModel(): Promise<string>;
  resolveModels(): Promise<ModelListResult>;
  setCurrentModel(name: string): Promise<unknown>;
}

export interface GatewayServerOptions {
  chat: ChatBridge;
  publicDirectory?: string;
  sessions?: SessionStore;
  deployments?: DeploymentRepository;
  deploymentCleanup?: (record: DeploymentRecord, options: { projectsRoot: string; skillsRoot: string; workspaceDirectories: readonly string[]; guestProjectsRoots: readonly string[]; force: boolean }) => Promise<CleanupStep[]>;
  deploymentInspect?: (record: DeploymentRecord) => Promise<DeploymentDoctorResult>;
  modelState?: GatewayModelState;
  contextWindow?: (model: string) => number | Promise<number>;
  log?: (message: string) => void;
  auth?: { enabled: boolean; username: string; password: string };
  authPasswordFromEnvironment?: boolean;
  authSessions?: AuthSessionStore;
  apiKeys?: ApiKeyStore;
  loginLocks?: LoginLockStore;
  uploadsDirectory?: string;
  ossUpload?: typeof uploadToOss;
  confirmations?: ConfirmationBroker;
  configState?: { load(): Promise<TaiweiConfig>; save(config: TaiweiConfig): Promise<void>; authPasswordHasEnvironmentTemplate?(): Promise<boolean> };
  hooks?: HookRunner;
  skillLoader?: Pick<SkillLoader, 'list' | 'load'> & Partial<Pick<SkillLoader, 'setDisabled' | 'isDisabled'>>;
  userSkillStore?: UserSkillStore;
  userSkillStateStore?: UserSkillStateStore;
  toolRegistry?: ToolRegistry;
  knowledgeDirectory?: string;
  ragIndexPath?: string;
  memoryDirectory?: string;
  memoryStore?: Pick<MemoryStore, 'read' | 'replace' | 'clear'>;
  buildKnowledgeIndex?: () => Promise<RagIndexData>;
  searchKnowledge?: (query: string, limit: number) => Promise<SearchResult[]>;
  mcpBridge?: {
    reload(): Promise<void>;
    list(): Array<{ name: string; connected: boolean; detail: string }>;
    test(config: McpServerConfig): Promise<{ connected: boolean; detail: string }>;
  };
  mcpConfigPath?: string;
  /** Defaults to the real history index for the normal SessionStore; custom stores may inject their own index. */
  history?: GatewayHistoryIndex | false;
  cronJobs?: CronJobStore;
  cronScheduler?: CronScheduler;
  pluginLoader?: Pick<PluginLoader, 'list' | 'setEnabled'>;
  folderStoreFactory?: (identity: { role: 'admin' | 'guest'; guestId?: string; username?: string; config: TaiweiConfig }) => FolderStore;
  tenantAccounts?: TenantAccountService | false;
  /** Test/deployment override; production tenant homes default to /home. */
  tenantHomeRoot?: string;
  /** Test/operations override. Defaults to 15 minutes. */
  pendingTurnTimeoutMs?: number;
}

export interface PendingTurn {
  turnId: string;
  sessionId: string;
  runtimeSessionId: string;
  startedAt: string;
  answer: string;
  toolCalls: SessionToolCall[];
  usage?: SessionUsage;
  lastSavedAt: number;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));

export interface GatewayRuntime {
  options: GatewayServerOptions;
  log: (message: string) => void;
  publicDirectory: string;
  sessions: SessionStore;
  deployments: DeploymentRepository;
  historyIndex: GatewayHistoryIndex | false;
  authSessions: AuthSessionStore;
  apiKeyStore: ApiKeyStore;
  loginLocks: LoginLockStore;
  confirmations: ConfirmationBroker;
  configState: { load(): Promise<TaiweiConfig>; save(config: TaiweiConfig): Promise<void>; authPasswordHasEnvironmentTemplate?(): Promise<boolean> };
  uploadsDirectory: string;
  taiweiPaths: ReturnType<typeof getPaths>;
  startupCleanup: Promise<void>;
  skillLoader: NonNullable<GatewayServerOptions['skillLoader']>;
  userSkillStore: UserSkillStore;
  userSkillStateStore: UserSkillStateStore;
  toolRegistry: ToolRegistry | undefined;
  knowledgeDirectory: string;
  ragIndexPath: string;
  memoryDirectory: string;
  mcpConfigPath: string;
  memoryStore: Pick<MemoryStore, 'read' | 'replace' | 'clear'>;
  tenantAccounts: TenantAccountService | false;
  sessionIdentity(role: 'admin' | 'guest', username: string): Promise<SessionIdentity>;
  guestWorkspaceCache: Map<string, Promise<string>>;
  oauthStates: Map<string, number>;
  stopRequested: Set<string>;
  pendingTurns: Map<string, PendingTurn>;
  modelState: GatewayModelState;
  contextWindowFor(model: string): Promise<number> | number;
  requireMcpBridge(): NonNullable<GatewayServerOptions['mcpBridge']>;
  mcpSnapshot(reload?: boolean): Promise<{ servers: ReturnType<typeof publicMcpServer>[]; statuses: Array<{ name: string; connected: boolean; detail: string }> }>;
  saveMcpServers(servers: McpServerConfig[]): Promise<void>;
  allSkills(config: TaiweiConfig): Promise<Skill[]>;
  toolSnapshot(): Promise<{ tools: Array<{ name: string; description: string; enabled: boolean; configurable: boolean; configSchema?: ToolConfigSchema; config: Record<string, unknown> }> }>;
  modelFailureCounts: Map<string, number>;
  requireDeployments(): Promise<DeploymentRepository>;
  buildKnowledgeIndex(): Promise<RagIndexData>;
  searchKnowledge(query: string, limit: number): Promise<SearchResult[]>;
  migrateLegacyGuestStorage(legacyGuestId: string, guestId: string): Promise<void>;
}

export function createGatewayRuntime(options: GatewayServerOptions): GatewayRuntime {
  const log = options.log ?? console.log;
  const taiweiPaths = getPaths();
  const sessions = options.sessions ?? new SessionStore();
  const deployments = options.deployments ?? new DeploymentStore();
  const historyIndex: GatewayHistoryIndex | false = options.history ?? (options.sessions ? false : {
    upsertSession: upsertHistorySession,
    appendMessage: appendHistoryMessage,
  });
  const authSessions = options.authSessions ?? new AuthSessionStore();
  const apiKeyStore = options.apiKeys ?? new ApiKeyStore();
  const loginLocks = options.loginLocks ?? new LoginLockStore();
  const confirmations = options.confirmations ?? new ConfirmationBroker();
  const configState = options.configState ?? { load: loadConfig, save: saveConfig, authPasswordHasEnvironmentTemplate };
  const uploadsDirectory = resolve(options.uploadsDirectory ?? taiweiPaths.uploads);
  const startupCleanup = (async () => {
    let finalized = await sessions.finalizeStalePending();
    try {
      const guests = await readdir(taiweiPaths.guests, { withFileTypes: true });
      for (const guest of guests) {
        if (!guest.isDirectory()) continue;
        finalized += await SessionStore.forGuest(guest.name).finalizeStalePending();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (finalized) log(`[taiwei] finalized ${finalized} stale pending gateway turn(s)`);
  })().catch((error) => log(`[taiwei] stale pending cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
  const skillLoader = options.skillLoader ?? new SkillLoader();
  const userSkillStore = options.userSkillStore ?? new UserSkillStore(taiweiPaths.userSkills);
  const userSkillStateStore = options.userSkillStateStore ?? new UserSkillStateStore(taiweiPaths.skillStates);
  const toolRegistry = options.toolRegistry;
  const knowledgeDirectory = resolve(options.knowledgeDirectory ?? taiweiPaths.knowledge);
  const ragIndexPath = resolve(options.ragIndexPath ?? taiweiPaths.ragIndex);
  const memoryDirectory = resolve(options.memoryDirectory ?? taiweiPaths.memoryDir);
  const mcpConfigPath = resolve(options.mcpConfigPath ?? taiweiPaths.mcp);
  const memoryStore = options.memoryStore ?? new MemoryStore();
  const tenantAccounts: TenantAccountService | false = options.tenantAccounts ?? new TenantAccountService(
    () => configState.load(), new TenantAccountStore(taiweiPaths.historyDb),
  );
  const sessionIdentity = async (role: 'admin' | 'guest', username: string): Promise<SessionIdentity> => {
    if (role === 'admin') return { role, username: 'admin' };
    const identity: SessionIdentity = { role, username };
    if (!tenantAccounts) return identity;
    try {
      const account = await tenantAccounts.store.getByUsername(username);
      if (!account) return identity;
      return {
        ...identity,
        accountName: account.accountName,
        osUsername: account.osUsername,
        giteaUsername: account.giteaUsername,
        giteaOrgName: account.giteaOrgName,
      };
    } catch (error) {
      log(`[taiwei] tenant identity snapshot unavailable for ${username}: ${error instanceof Error ? error.message : String(error)}`);
      return identity;
    }
  };
  const guestWorkspaceCache = new Map<string, Promise<string>>();
  let mcpInitialized = false;
  const buildKnowledgeIndex = options.buildKnowledgeIndex ?? (async () => buildIndex(createEmbedder(await configState.load())));
  const searchKnowledge = options.searchKnowledge ?? (async (query: string, limit: number) => retrieve(query, limit, createEmbedder(await configState.load())));
  const startupAuthEnabled = options.auth?.enabled ?? false;
  if (startupAuthEnabled && !options.auth?.password) {
    throw new Error('Gateway auth is enabled but no password is set. Set auth.password in ~/.taiwei/config.json or TAIWEI_AUTH_PASSWORD.');
  }
  const migrateLegacyGuestStorage = async (legacyGuestId: string, guestId: string): Promise<void> => {
    if (legacyGuestId === guestId) return;
    const legacyDirectory = join(taiweiPaths.guests, legacyGuestId);
    const destination = join(taiweiPaths.guests, guestId);
    try {
      await stat(destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      // Compatibility strategy: old slug/truncated-token storage is moved once,
      // before any new hashed directory is created. Existing guest data therefore
      // remains visible while all subsequent access uses the collision-resistant key.
      await mkdir(taiweiPaths.guests, { recursive: true });
      await rename(legacyDirectory, destination);
      await SessionStore.moveGuestScope(legacyGuestId, guestId);
      const foldersFile = join(destination, 'folders.json');
      try {
        const folders = JSON.parse(await readFile(foldersFile, 'utf8')) as unknown;
        if (Array.isArray(folders)) {
          let changed = false;
          for (const item of folders) {
            if (!item || typeof item !== 'object') continue;
            const folder = item as { path?: unknown };
            if (typeof folder.path !== 'string') continue;
            const suffix = relative(legacyDirectory, folder.path);
            if (suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))) {
              folder.path = resolve(destination, suffix);
              changed = true;
            }
          }
          if (changed) await writeFile(foldersFile, `${JSON.stringify(folders, null, 2)}\n`, 'utf8');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`[taiwei] could not rewrite migrated guest folders: ${(error as Error).message}`);
      }
      log(`[taiwei] migrated legacy guest storage ${legacyGuestId} -> ${guestId}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    }
  };
  let deploymentInitializationError: Error | undefined;
  const deploymentReady = deployments.initialize().catch((error) => {
    deploymentInitializationError = error instanceof Error ? error : new Error(String(error));
    log(`[taiwei] deployment database unavailable: ${deploymentInitializationError.message}`);
  });
  const requireDeployments = async () => {
    await deploymentReady;
    if (deploymentInitializationError) throw new HttpError(503, `Deployment database is unavailable: ${deploymentInitializationError.message}`);
    return deployments;
  };
  if (tenantAccounts) void tenantAccounts.store.initialize().catch((error) => log(`[taiwei] tenant account database unavailable: ${error instanceof Error ? error.message : String(error)}`));
  const oauthStates = new Map<string, number>();
  const stopRequested = new Set<string>();
  const pendingTurns = new Map<string, PendingTurn>();
  const modelState: GatewayModelState = options.modelState ?? { getCurrentModel, resolveModels: resolveModelCatalog, setCurrentModel };
  const contextWindowFor = options.contextWindow ?? (async (model: string) => resolveContextWindow(await loadConfig(), model));
  const requireMcpBridge = () => {
    if (!options.mcpBridge) throw new HttpError(503, 'MCP bridge is unavailable');
    return options.mcpBridge;
  };
  const mcpSnapshot = async (reload = false) => {
    const bridge = requireMcpBridge();
    if (reload || !mcpInitialized) {
      await bridge.reload();
      mcpInitialized = true;
    }
    const servers = await loadMcpConfig(mcpConfigPath);
    return { servers: servers.map(publicMcpServer), statuses: bridge.list() };
  };
  const saveMcpServers = async (servers: McpServerConfig[]) => {
    await mkdir(dirname(mcpConfigPath), { recursive: true });
    await writeFile(mcpConfigPath, `${JSON.stringify(servers, null, 2)}\n`, 'utf8');
  };
  const allSkills = async (config: TaiweiConfig): Promise<Skill[]> => {
    skillLoader.setDisabled?.(config.skillsDisabled);
    return skillLoader.list({ includeDisabled: true });
  };
  const toolSnapshot = async () => {
    if (!toolRegistry) throw new HttpError(503, 'Tool registry is unavailable');
    const config = await configState.load();
    toolRegistry.configure(resolveToolSettings(config));
    return { tools: toolRegistry.list({ includeDisabled: true }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      enabled: toolRegistry.isEnabled(tool.name),
      configurable: Boolean(tool.configSchema && Object.keys(tool.configSchema).length),
      ...(tool.configSchema ? { configSchema: tool.configSchema } : {}),
      config: toolRegistry.getConfig(tool.name),
    })) };
  };
  const modelFailureCounts = new Map<string, number>();
  return {
    options,
    log,
    publicDirectory: options.publicDirectory ?? DEFAULT_PUBLIC_DIRECTORY,
    sessions,
    deployments,
    historyIndex,
    authSessions,
    apiKeyStore,
    loginLocks,
    confirmations,
    configState,
    uploadsDirectory,
    taiweiPaths,
    startupCleanup,
    skillLoader,
    userSkillStore,
    userSkillStateStore,
    toolRegistry,
    knowledgeDirectory,
    ragIndexPath,
    memoryDirectory,
    mcpConfigPath,
    memoryStore,
    tenantAccounts,
    sessionIdentity,
    guestWorkspaceCache,
    oauthStates,
    stopRequested,
    pendingTurns,
    modelState,
    contextWindowFor,
    requireMcpBridge,
    mcpSnapshot,
    saveMcpServers,
    allSkills,
    toolSnapshot,
    modelFailureCounts,
    requireDeployments,
    buildKnowledgeIndex,
    searchKnowledge,
    migrateLegacyGuestStorage,
  };
}
