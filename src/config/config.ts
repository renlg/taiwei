import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureTaiweiHome } from '../util/paths.js';
import { HOOK_EVENTS, type HookCommands } from '../hooks/runner.js';
import { passwordForStorage } from './password.js';
import type { PolicyConfig } from '../security/policy.js';
import type { ProviderConfig } from '../llm/providers/types.js';
import { DEFAULT_LSP_SERVERS, type LspServerConfig } from '../lsp/client.js';

export type SecurityRememberMode = 'off' | 'session' | 'permanent';

export interface ToolSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

export type BashBackend = 'local' | 'docker' | 'ssh';

export interface BashConfig {
  backend: BashBackend;
  docker?: { image: string; network?: string; extraArgs?: string[] };
  ssh?: { host: string; port?: number; user?: string; keyPath?: string; commandPrefix?: string };
}

export interface TaiweiConfig {
  model: string;
  /** 用户模型授权：username -> 被授权可用的 adminOnly 模型 id 列表。 */
  modelGrants?: Record<string, string[]>;
  embedModel: string;
  models?: string[];
  contextWindow?: number;
  contextWindows?: Record<string, number>;
  compressThreshold?: number;
  memoryFlush: boolean;
  skillSelfLearning: boolean;
  skillSelfLearningModel?: string;
  baseUrl: string;
  /** 对外访问地址，如 http://14.103.23.160，可选；nginx_add_proxy 优先使用。 */
  publicUrl?: string;
  /** Legacy alias accepted on read. Prefer baseUrl or providers[].baseUrl. */
  apiBaseUrl?: string;
  apiKey: string;
  providers: ProviderConfig[];
  defaultProvider: string;
  maxTurns: number;
  requestTimeoutMs: number;
  fallbackModel?: string;
  tokenEstimateCharsPerToken: number;
  budget: { systemMax: number; historyMax: number; toolsMax: number; outputReserve: number };
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; maxFeedbackIterations: number };
  runtime: { maxConcurrentTurns: number };
  bash: BashConfig;
  lsp: { enabled: boolean; maxDiagnostics: number; autoInject: boolean; servers: LspServerConfig[] };
  policy: PolicyConfig;
  customPrompt: string;
  hookTimeoutSeconds: number;
  hooks: HookCommands;
  autoLoadSkills?: boolean;
  skillsDisabled?: string[];
  tools?: Record<string, ToolSettings>;
  plugins?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  delegation: { maxConcurrent: number; maxDepth: number };
  browser: { headless: boolean; userDataDir: string; idleMinutes: number };
  gateway: {
    host: string;
    port: number;
    multimodal: { enabled: boolean };
  };
  oss: {
    enabled: boolean;
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    endpoint: string;
    prefix: string;
  };
  auth: {
    enabled: boolean;
    username: string;
    password: string;
  };
  oauth: {
    enabled: boolean;
    providerBaseUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  gitea: {
    baseUrl: string;
    adminToken: string;
  };
  share: { enabled: boolean; token: string; createdAt: string };
  workspace: {
    dir: string;
  };
  security: {
    enabled: boolean;
    patterns: string[];
    timeoutSeconds: number;
    remember: SecurityRememberMode;
    approvedPatterns: string[];
  };
}

export const DEFAULT_CONFIG: TaiweiConfig = {
  model: 'gpt-4.1-mini',
  embedModel: 'embeddings',
  contextWindow: 256_000,
  compressThreshold: 0.7,
  memoryFlush: true,
  skillSelfLearning: false,
  baseUrl: 'https://api.openai.com/v1',
  publicUrl: '',
  apiKey: '',
  providers: [],
  defaultProvider: 'default',
  maxTurns: 50,
  requestTimeoutMs: 120_000,
  tokenEstimateCharsPerToken: 4,
  budget: { systemMax: 20_000, historyMax: 180_000, toolsMax: 30_000, outputReserve: 16_000 },
  retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000, maxFeedbackIterations: 2 },
  runtime: { maxConcurrentTurns: 4 },
  bash: { backend: 'local' },
  lsp: { enabled: true, maxDiagnostics: 5, autoInject: true, servers: DEFAULT_LSP_SERVERS },
  policy: { rules: [] },
  customPrompt: '',
  hookTimeoutSeconds: 10,
  hooks: {
    beforeMessage: [],
    beforeLLM: [],
    afterLLM: [],
    beforeTool: [],
    afterTool: [],
  },
  autoLoadSkills: true,
  delegation: { maxConcurrent: 3, maxDepth: 2 },
  browser: { headless: true, userDataDir: '', idleMinutes: 10 },
  gateway: {
    host: '127.0.0.1',
    port: 8688,
    multimodal: { enabled: true },
  },
  oss: {
    enabled: false,
    accessKeyId: '',
    accessKeySecret: '',
    bucket: 'renlg',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    prefix: 'taiwei',
  },
  auth: {
    enabled: false,
    username: 'admin',
    password: '',
  },
  oauth: {
    enabled: false,
    providerBaseUrl: '',
    clientId: 'taiwei',
    clientSecret: 'taiwei-secret-2026',
    redirectUri: '',
  },
  gitea: {
    baseUrl: '',
    adminToken: '',
  },
  share: { enabled: false, token: '', createdAt: '' },
  workspace: {
    dir: '~/workspace',
  },
  security: {
    enabled: true,
    patterns: [],
    timeoutSeconds: 60,
    remember: 'off',
    approvedPatterns: [],
  },
};

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function resolveWorkspaceDir(config: Pick<TaiweiConfig, 'workspace'>): string {
  return expandHome(config.workspace.dir || DEFAULT_CONFIG.workspace.dir);
}

export function resolveContextWindow(config: TaiweiConfig, model = config.model): number {
  const configured = config.contextWindows?.[model] ?? config.contextWindow;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_CONFIG.contextWindow ?? 256_000;
}

export function resolveToolSettings(config: TaiweiConfig): Record<string, ToolSettings> {
  const settings = { ...(config.tools ?? {}) };
  for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_extract', 'browser_screenshot']) {
    settings[name] = { ...config.browser, ...settings[name] };
  }
  return settings;
}

export function resolveCompressThreshold(config: TaiweiConfig): number {
  const configured = config.compressThreshold;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 && configured <= 1
    ? configured
    : DEFAULT_CONFIG.compressThreshold ?? 0.7;
}

/** Resolve an environment template in an explicitly supported connection/secret field.
 * `$${VAR}` escapes interpolation and becomes the literal `${VAR}` at runtime.
 */
function resolveSecret(value: string): string {
  const escaped: string[] = [];
  const protectedValue = value.replace(/\$\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    escaped.push(`\${${name}}`);
    return `\u0000TAIWEI_ESC_${escaped.length - 1}\u0000`;
  });
  return protectedValue
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\u0000TAIWEI_ESC_(\d+)\u0000/g, (_match, index: string) => escaped[Number(index)]!);
}

function hasEnvironmentTemplate(value: string): boolean {
  return /(^|[^$])\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

function hasEnvironmentReference(value: string): boolean {
  return /\$\$?\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

/** Deliberately do not walk arbitrary strings such as prompts or hook commands. */
function resolveRuntimeSecrets(config: TaiweiConfig): TaiweiConfig {
  const resolved = structuredClone(config);
  resolved.apiKey = resolveSecret(resolved.apiKey);
  resolved.baseUrl = resolveSecret(resolved.baseUrl);
  if (resolved.publicUrl) resolved.publicUrl = resolveSecret(resolved.publicUrl);
  resolved.providers = resolved.providers.map((provider) => ({
    ...provider,
    apiKey: resolveSecret(provider.apiKey ?? ''),
    baseUrl: resolveSecret(provider.baseUrl),
  }));
  resolved.auth.password = resolveSecret(resolved.auth.password);
  resolved.oauth.providerBaseUrl = resolveSecret(resolved.oauth.providerBaseUrl);
  resolved.oauth.clientSecret = resolveSecret(resolved.oauth.clientSecret);
  resolved.oauth.redirectUri = resolveSecret(resolved.oauth.redirectUri);
  resolved.oss.accessKeyId = resolveSecret(resolved.oss.accessKeyId);
  resolved.oss.accessKeySecret = resolveSecret(resolved.oss.accessKeySecret);
  resolved.oss.endpoint = resolveSecret(resolved.oss.endpoint);
  resolved.gitea.baseUrl = resolveSecret(resolved.gitea.baseUrl);
  resolved.gitea.adminToken = resolveSecret(resolved.gitea.adminToken);
  resolved.share.token = resolveSecret(resolved.share.token);
  return resolved;
}

export async function loadConfig(): Promise<TaiweiConfig> {
  const paths = await ensureTaiweiHome();
  let stored: Partial<TaiweiConfig> = {};
  try {
    stored = JSON.parse(await readFile(paths.config, 'utf8')) as Partial<TaiweiConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Invalid config at ${paths.config}: ${(error as Error).message}`);
    }
    await saveConfig(DEFAULT_CONFIG);
  }
  const { guests: _ignoredGuests, ...storedConfig } = stored as Partial<TaiweiConfig> & { guests?: unknown };
  const legacyBaseUrl = typeof (storedConfig as { apiBaseUrl?: unknown }).apiBaseUrl === 'string'
    ? (storedConfig as { apiBaseUrl: string }).apiBaseUrl : storedConfig.baseUrl;
  let config: TaiweiConfig = {
    ...DEFAULT_CONFIG,
    ...storedConfig,
    customPrompt: typeof storedConfig.customPrompt === 'string' ? storedConfig.customPrompt : DEFAULT_CONFIG.customPrompt,
    compressThreshold: resolveCompressThreshold({ ...DEFAULT_CONFIG, ...storedConfig } as TaiweiConfig),
    memoryFlush: typeof storedConfig.memoryFlush === 'boolean' ? storedConfig.memoryFlush : DEFAULT_CONFIG.memoryFlush,
    skillSelfLearning: typeof storedConfig.skillSelfLearning === 'boolean' ? storedConfig.skillSelfLearning : DEFAULT_CONFIG.skillSelfLearning,
    hookTimeoutSeconds: normalizeHookTimeout(storedConfig.hookTimeoutSeconds),
    hooks: normalizeHooks(storedConfig.hooks),
    autoLoadSkills: storedConfig.autoLoadSkills ?? DEFAULT_CONFIG.autoLoadSkills,
    skillsDisabled: normalizeStringList(storedConfig.skillsDisabled),
    tools: normalizeToolSettings(storedConfig.tools),
    delegation: { ...DEFAULT_CONFIG.delegation, ...storedConfig.delegation },
    budget: { ...DEFAULT_CONFIG.budget, ...storedConfig.budget },
    retry: { ...DEFAULT_CONFIG.retry, ...storedConfig.retry },
    runtime: { ...DEFAULT_CONFIG.runtime, ...storedConfig.runtime },
    bash: mergeBashConfig(storedConfig.bash),
    lsp: normalizeLsp(storedConfig.lsp),
    policy: { rules: Array.isArray(storedConfig.policy?.rules) ? storedConfig.policy.rules : [] },
    browser: { ...DEFAULT_CONFIG.browser, ...storedConfig.browser },
    gateway: { ...DEFAULT_CONFIG.gateway, ...storedConfig.gateway },
    oss: { ...DEFAULT_CONFIG.oss, ...storedConfig.oss },
    auth: { ...DEFAULT_CONFIG.auth, ...storedConfig.auth },
    oauth: { ...DEFAULT_CONFIG.oauth, ...storedConfig.oauth },
    gitea: { ...DEFAULT_CONFIG.gitea, ...storedConfig.gitea },
    share: { ...DEFAULT_CONFIG.share, ...storedConfig.share },
    workspace: { ...DEFAULT_CONFIG.workspace, ...storedConfig.workspace },
    security: {
      ...DEFAULT_CONFIG.security,
      ...stored.security,
      patterns: [...(stored.security?.patterns ?? DEFAULT_CONFIG.security.patterns)],
      approvedPatterns: [...(stored.security?.approvedPatterns ?? DEFAULT_CONFIG.security.approvedPatterns)],
    },
    apiKey: stored.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseUrl: legacyBaseUrl ?? DEFAULT_CONFIG.baseUrl,
    publicUrl: storedConfig.publicUrl ?? DEFAULT_CONFIG.publicUrl,
    model: stored.model ?? DEFAULT_CONFIG.model,
    embedModel: stored.embedModel ?? DEFAULT_CONFIG.embedModel,
  };
  const rawPassword = config.auth.password;
  if (!hasEnvironmentTemplate(rawPassword)) {
    const diskPassword = passwordForStorage(resolveSecret(rawPassword));
    if (diskPassword !== rawPassword) {
      config.auth.password = diskPassword;
      await saveConfig(config);
    }
  }
  config = resolveRuntimeSecrets(config);
  config.apiKey = process.env.TAIWEI_API_KEY ?? config.apiKey;
  config.baseUrl = process.env.TAIWEI_BASE_URL ?? config.baseUrl;
  config.model = process.env.TAIWEI_MODEL ?? config.model;
  config.providers = normalizeProviders(config.providers, config);
  config.defaultProvider = config.providers.some((provider) => provider.id === config.defaultProvider) ? config.defaultProvider : config.providers[0]!.id;
  if (process.env.TAIWEI_AUTH_PASSWORD !== undefined) config.auth.password = process.env.TAIWEI_AUTH_PASSWORD;
  if (process.env.OAUTH_TAIWEI_SECRET !== undefined) config.oauth.clientSecret = process.env.OAUTH_TAIWEI_SECRET;
  if (process.env.OAUTH_TAIWEI_REDIRECT !== undefined) config.oauth.redirectUri = process.env.OAUTH_TAIWEI_REDIRECT;
  if (process.env.TAIWEI_OSS_SECRET !== undefined) config.oss.accessKeySecret = process.env.TAIWEI_OSS_SECRET;
  if (process.env.GITEA_ADMIN_TOKEN !== undefined) config.gitea.adminToken = process.env.GITEA_ADMIN_TOKEN;
  for (const provider of config.providers) {
    const envKey = `TAIWEI_PROVIDER_${provider.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
    if (process.env[envKey] !== undefined) provider.apiKey = process.env[envKey]!;
  }
  return config;
}

function normalizeProviders(value: unknown, legacy: Pick<TaiweiConfig, 'baseUrl' | 'apiKey' | 'model' | 'models' | 'contextWindow'>): ProviderConfig[] {
  const configured = Array.isArray(value) ? value.flatMap((item): ProviderConfig[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<ProviderConfig>;
    if (typeof candidate.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(candidate.id)
      || typeof candidate.name !== 'string' || typeof candidate.baseUrl !== 'string'
      || !['openai-compatible', 'anthropic', 'responses'].includes(candidate.type ?? '')) return [];
    return [{ ...candidate, apiKey: candidate.apiKey ?? '' } as ProviderConfig];
  }) : [];
  if (configured.length) return configured.map((provider) => provider.id === 'default' ? {
    ...provider,
    baseUrl: process.env.TAIWEI_BASE_URL ?? provider.baseUrl,
    apiKey: process.env.TAIWEI_API_KEY ?? provider.apiKey,
    defaultModel: process.env.TAIWEI_MODEL ?? provider.defaultModel,
  } : provider);
  return [{
    id: 'default', name: 'Default', type: 'openai-compatible', baseUrl: legacy.baseUrl,
    apiKey: legacy.apiKey, defaultModel: legacy.model,
    models: (legacy.models?.length ? legacy.models : [legacy.model]).map((id) => ({
      id, provider: 'default', displayName: id,
      capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: legacy.contextWindow ?? 256_000 },
      adminOnly: undefined,
    })),
  }];
}

export async function saveConfig(config: TaiweiConfig): Promise<void> {
  const paths = await ensureTaiweiHome();
  const { guests: _ignoredGuests, ...configWithoutGuests } = config as TaiweiConfig & { guests?: unknown };
  const stored = structuredClone(configWithoutGuests) as TaiweiConfig;
  await stripEnvironmentOverrides(config, stored, paths.config);
  stored.auth.password = hasEnvironmentTemplate(stored.auth.password)
    ? stored.auth.password
    : passwordForStorage(stored.auth.password);
  await writeFile(paths.config, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

/**
 * 环境变量覆盖（TAIWEI_API_KEY / TAIWEI_BASE_URL / TAIWEI_MODEL /
 * TAIWEI_AUTH_PASSWORD / OAUTH_TAIWEI_SECRET / OAUTH_TAIWEI_REDIRECT）只在运行时生效。
 * 当流入 saveConfig 的值仍等于环境变量值（即来自 loadConfig 的覆盖、并非用户刻意修改），
 * 写盘前恢复为磁盘原值，避免通过环境变量提供的密钥被持久化到 config.json。
 */
async function stripEnvironmentOverrides(config: TaiweiConfig, stored: TaiweiConfig, configPath: string): Promise<void> {
  const env = process.env;
  const hasProviderOverride = config.providers.some((provider) => process.env[`TAIWEI_PROVIDER_${provider.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`] !== undefined);
  const hasAny = env.TAIWEI_API_KEY !== undefined || env.TAIWEI_BASE_URL !== undefined || env.TAIWEI_MODEL !== undefined
    || env.TAIWEI_AUTH_PASSWORD !== undefined || env.OAUTH_TAIWEI_SECRET !== undefined || env.OAUTH_TAIWEI_REDIRECT !== undefined
    || env.TAIWEI_OSS_SECRET !== undefined || env.GITEA_ADMIN_TOKEN !== undefined || hasProviderOverride;
  let disk: Partial<TaiweiConfig> = {};
  try { disk = JSON.parse(await readFile(configPath, 'utf8')) as Partial<TaiweiConfig>; }
  catch { /* no previous on-disk config: nothing to restore */ }
  restoreInterpolatedFields(stored, disk);
  if (!hasAny) return;
  const restore = (value: string | undefined, override: string | undefined, diskValue: unknown, fallback: string): string | undefined =>
    override !== undefined && value === override ? (typeof diskValue === 'string' ? diskValue : fallback) : value;
  stored.apiKey = restore(config.apiKey, env.TAIWEI_API_KEY, disk.apiKey, '')!;
  stored.baseUrl = restore(config.baseUrl, env.TAIWEI_BASE_URL, disk.apiBaseUrl ?? disk.baseUrl, DEFAULT_CONFIG.baseUrl)!;
  stored.model = restore(config.model, env.TAIWEI_MODEL, disk.model, DEFAULT_CONFIG.model)!;
  if (env.TAIWEI_AUTH_PASSWORD !== undefined && config.auth.password === env.TAIWEI_AUTH_PASSWORD) {
    stored.auth = { ...stored.auth, password: typeof disk.auth?.password === 'string' ? disk.auth.password : '' };
  }
  if (env.OAUTH_TAIWEI_SECRET !== undefined && config.oauth.clientSecret === env.OAUTH_TAIWEI_SECRET) {
    stored.oauth = { ...stored.oauth, clientSecret: typeof disk.oauth?.clientSecret === 'string' ? disk.oauth.clientSecret : DEFAULT_CONFIG.oauth.clientSecret };
  }
  if (env.OAUTH_TAIWEI_REDIRECT !== undefined && config.oauth.redirectUri === env.OAUTH_TAIWEI_REDIRECT) {
    stored.oauth = { ...stored.oauth, redirectUri: typeof disk.oauth?.redirectUri === 'string' ? disk.oauth.redirectUri : DEFAULT_CONFIG.oauth.redirectUri };
  }
  if (env.TAIWEI_OSS_SECRET !== undefined && config.oss.accessKeySecret === env.TAIWEI_OSS_SECRET) {
    stored.oss = { ...stored.oss, accessKeySecret: typeof disk.oss?.accessKeySecret === 'string' ? disk.oss.accessKeySecret : '' };
  }
  if (env.GITEA_ADMIN_TOKEN !== undefined && config.gitea.adminToken === env.GITEA_ADMIN_TOKEN) {
    stored.gitea = { ...stored.gitea, adminToken: typeof disk.gitea?.adminToken === 'string' ? disk.gitea.adminToken : '' };
  }
  const defaultIndex = stored.providers?.findIndex((provider) => provider.id === 'default') ?? -1;
  if (defaultIndex >= 0 && stored.providers) {
    const diskProvider = Array.isArray(disk.providers) ? disk.providers.find((provider) => provider?.id === 'default') : undefined;
    const providers = [...stored.providers];
    const provider = { ...providers[defaultIndex]! };
    provider.apiKey = restore(provider.apiKey, env.TAIWEI_API_KEY, diskProvider?.apiKey, '')!;
    provider.baseUrl = restore(provider.baseUrl, env.TAIWEI_BASE_URL, diskProvider?.baseUrl, DEFAULT_CONFIG.baseUrl)!;
    provider.defaultModel = restore(provider.defaultModel, env.TAIWEI_MODEL, diskProvider?.defaultModel, DEFAULT_CONFIG.model)!;
    providers[defaultIndex] = provider;
    stored.providers = providers;
  }
  if (stored.providers) {
    stored.providers = stored.providers.map((provider) => {
      const envKey = `TAIWEI_PROVIDER_${provider.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
      const override = env[envKey];
      const diskProvider = Array.isArray(disk.providers) ? disk.providers.find((candidate) => candidate?.id === provider.id) : undefined;
      return override !== undefined && config.providers.find((candidate) => candidate.id === provider.id)?.apiKey === override
        ? { ...provider, apiKey: typeof diskProvider?.apiKey === 'string' ? diskProvider.apiKey : '' }
        : provider;
    });
  }
}

/** Restore unresolved disk templates when saveConfig receives a runtime-resolved config. */
function restoreInterpolatedFields(stored: TaiweiConfig, disk: Partial<TaiweiConfig>): void {
  const restore = (runtime: string, raw: unknown): string =>
    typeof raw === 'string' && hasEnvironmentReference(raw) && resolveSecret(raw) === runtime ? raw : runtime;
  stored.apiKey = restore(stored.apiKey, disk.apiKey);
  stored.baseUrl = restore(stored.baseUrl, disk.apiBaseUrl ?? disk.baseUrl);
  if (stored.publicUrl !== undefined) stored.publicUrl = restore(stored.publicUrl, disk.publicUrl);
  stored.auth.password = restore(stored.auth.password, disk.auth?.password);
  stored.oauth.providerBaseUrl = restore(stored.oauth.providerBaseUrl, disk.oauth?.providerBaseUrl);
  stored.oauth.clientSecret = restore(stored.oauth.clientSecret, disk.oauth?.clientSecret);
  stored.oauth.redirectUri = restore(stored.oauth.redirectUri, disk.oauth?.redirectUri);
  stored.oss.accessKeyId = restore(stored.oss.accessKeyId, disk.oss?.accessKeyId);
  stored.oss.accessKeySecret = restore(stored.oss.accessKeySecret, disk.oss?.accessKeySecret);
  stored.oss.endpoint = restore(stored.oss.endpoint, disk.oss?.endpoint);
  stored.gitea.baseUrl = restore(stored.gitea.baseUrl, disk.gitea?.baseUrl);
  stored.gitea.adminToken = restore(stored.gitea.adminToken, disk.gitea?.adminToken);
  stored.share.token = restore(stored.share.token, disk.share?.token);
  if (Array.isArray(stored.providers)) {
    stored.providers = stored.providers.map((provider) => {
      const raw = (Array.isArray(disk.providers) ? disk.providers.find((candidate) => candidate?.id === provider.id) : undefined)
        ?? (provider.id === 'default' ? { apiKey: disk.apiKey, baseUrl: disk.apiBaseUrl ?? disk.baseUrl } : undefined);
      return raw ? { ...provider, apiKey: restore(provider.apiKey ?? '', raw.apiKey), baseUrl: restore(provider.baseUrl, raw.baseUrl) } : provider;
    });
  }
}

export async function initializeConfig(): Promise<TaiweiConfig> {
  const paths = await ensureTaiweiHome();
  try {
    const stored = JSON.parse(await readFile(paths.config, 'utf8')) as Partial<TaiweiConfig>;
    const { guests: _ignoredGuests, ...storedConfig } = stored as Partial<TaiweiConfig> & { guests?: unknown };
    const config: TaiweiConfig = {
      ...DEFAULT_CONFIG,
      ...storedConfig,
      customPrompt: typeof storedConfig.customPrompt === 'string' ? storedConfig.customPrompt : DEFAULT_CONFIG.customPrompt,
      compressThreshold: resolveCompressThreshold({ ...DEFAULT_CONFIG, ...storedConfig } as TaiweiConfig),
      memoryFlush: typeof storedConfig.memoryFlush === 'boolean' ? storedConfig.memoryFlush : DEFAULT_CONFIG.memoryFlush,
      skillSelfLearning: typeof storedConfig.skillSelfLearning === 'boolean' ? storedConfig.skillSelfLearning : DEFAULT_CONFIG.skillSelfLearning,
      hookTimeoutSeconds: normalizeHookTimeout(storedConfig.hookTimeoutSeconds),
      hooks: normalizeHooks(storedConfig.hooks),
      skillsDisabled: normalizeStringList(storedConfig.skillsDisabled),
      tools: normalizeToolSettings(storedConfig.tools),
      publicUrl: storedConfig.publicUrl ?? DEFAULT_CONFIG.publicUrl,
      delegation: { ...DEFAULT_CONFIG.delegation, ...storedConfig.delegation },
      budget: { ...DEFAULT_CONFIG.budget, ...storedConfig.budget },
      retry: { ...DEFAULT_CONFIG.retry, ...storedConfig.retry },
      runtime: { ...DEFAULT_CONFIG.runtime, ...storedConfig.runtime },
      bash: mergeBashConfig(storedConfig.bash),
      lsp: normalizeLsp(storedConfig.lsp),
      policy: { rules: Array.isArray(storedConfig.policy?.rules) ? storedConfig.policy.rules : [] },
      browser: { ...DEFAULT_CONFIG.browser, ...storedConfig.browser },
      gateway: { ...DEFAULT_CONFIG.gateway, ...storedConfig.gateway },
      oss: { ...DEFAULT_CONFIG.oss, ...storedConfig.oss },
      auth: { ...DEFAULT_CONFIG.auth, ...storedConfig.auth },
      oauth: { ...DEFAULT_CONFIG.oauth, ...storedConfig.oauth },
      gitea: { ...DEFAULT_CONFIG.gitea, ...storedConfig.gitea },
      share: { ...DEFAULT_CONFIG.share, ...storedConfig.share },
      workspace: { ...DEFAULT_CONFIG.workspace, ...storedConfig.workspace },
      security: {
        ...DEFAULT_CONFIG.security,
        ...stored.security,
        patterns: [...(stored.security?.patterns ?? DEFAULT_CONFIG.security.patterns)],
        approvedPatterns: [...(stored.security?.approvedPatterns ?? DEFAULT_CONFIG.security.approvedPatterns)],
      },
    };
    if (!hasEnvironmentTemplate(config.auth.password)) {
      config.auth.password = passwordForStorage(config.auth.password);
    }
    await saveConfig(config);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await saveConfig(DEFAULT_CONFIG);
    return {
      ...DEFAULT_CONFIG,
      hooks: normalizeHooks(),
      delegation: { ...DEFAULT_CONFIG.delegation }, browser: { ...DEFAULT_CONFIG.browser },
      budget: { ...DEFAULT_CONFIG.budget }, retry: { ...DEFAULT_CONFIG.retry }, runtime: { ...DEFAULT_CONFIG.runtime }, bash: { ...DEFAULT_CONFIG.bash }, policy: { rules: [] },
      gateway: { ...DEFAULT_CONFIG.gateway },
      oss: { ...DEFAULT_CONFIG.oss },
      auth: { ...DEFAULT_CONFIG.auth },
      oauth: { ...DEFAULT_CONFIG.oauth },
      gitea: { ...DEFAULT_CONFIG.gitea },
      share: { ...DEFAULT_CONFIG.share },
      workspace: { ...DEFAULT_CONFIG.workspace },
      security: { ...DEFAULT_CONFIG.security, patterns: [], approvedPatterns: [] },
    };
  }
}

function mergeBashConfig(value: Partial<BashConfig> | undefined): BashConfig {
  return {
    ...DEFAULT_CONFIG.bash,
    ...value,
    ...(value?.docker ? { docker: { ...value.docker } } : {}),
    ...(value?.ssh ? { ssh: { ...value.ssh } } : {}),
  } as BashConfig;
}

function normalizeLspServers(value: unknown): LspServerConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const servers: LspServerConfig[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.command !== 'string' || !raw.command.trim()) continue;
    const extensions = Array.isArray(raw.extensions)
      ? raw.extensions.filter((extension): extension is string => typeof extension === 'string' && extension.startsWith('.'))
      : [];
    servers.push({
      command: raw.command.trim(),
      ...(Array.isArray(raw.args) ? { args: raw.args.filter((arg): arg is string => typeof arg === 'string') } : {}),
      extensions,
      ...(raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? {
        env: Object.fromEntries(Object.entries(raw.env as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      } : {}),
    });
  }
  return servers.length ? servers : undefined;
}

function normalizeLsp(value: unknown): TaiweiConfig['lsp'] {
  const raw = (value && typeof value === 'object' ? value : {}) as { enabled?: unknown; maxDiagnostics?: unknown; autoInject?: unknown; servers?: unknown };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.lsp.enabled,
    maxDiagnostics: typeof raw.maxDiagnostics === 'number' && raw.maxDiagnostics > 0 ? Math.floor(raw.maxDiagnostics) : DEFAULT_CONFIG.lsp.maxDiagnostics,
    autoInject: typeof raw.autoInject === 'boolean' ? raw.autoInject : DEFAULT_CONFIG.lsp.autoInject,
    servers: normalizeLspServers(raw.servers) ?? DEFAULT_CONFIG.lsp.servers,
  };
}

function normalizeHooks(value?: Partial<HookCommands>): HookCommands {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [
    event,
    Array.isArray(value?.[event]) ? value[event]!.filter((command): command is string => typeof command === 'string' && Boolean(command.trim())) : [],
  ])) as unknown as HookCommands;
}

function normalizeHookTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.min(3600, Math.floor(value))
    : DEFAULT_CONFIG.hookTimeoutSeconds;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function normalizeToolSettings(value: unknown): Record<string, ToolSettings> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([name, settings]) => {
    if (!name.trim() || !settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
    return [[name, { ...settings as ToolSettings }]];
  }));
}

export function validateGatewayAuth<T extends Pick<TaiweiConfig, 'auth'>>(config: T): void {
  if (config.auth.enabled && !config.auth.password) {
    throw new Error('Gateway auth is enabled but no password is set. Set auth.password in ~/.taiwei/config.json or TAIWEI_AUTH_PASSWORD.');
  }
}
