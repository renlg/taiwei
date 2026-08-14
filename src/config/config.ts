import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureTaiweiHome } from '../util/paths.js';
import { HOOK_EVENTS, type HookCommands } from '../hooks/runner.js';
import { passwordForStorage } from './password.js';
import type { PolicyConfig } from '../security/policy.js';

export type SecurityRememberMode = 'off' | 'session' | 'permanent';

export interface ToolSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface TaiweiConfig {
  model: string;
  embedModel: string;
  models?: string[];
  contextWindow?: number;
  contextWindows?: Record<string, number>;
  compressThreshold?: number;
  memoryFlush: boolean;
  baseUrl: string;
  apiKey: string;
  maxTurns: number;
  requestTimeoutMs: number;
  fallbackModel?: string;
  tokenEstimateCharsPerToken: number;
  budget: { systemMax: number; historyMax: number; toolsMax: number; outputReserve: number };
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  runtime: { maxConcurrentTurns: number };
  policy: PolicyConfig;
  customPrompt: string;
  hookTimeoutSeconds: number;
  hooks: HookCommands;
  autoLoadSkills?: boolean;
  skillsDisabled?: string[];
  tools?: Record<string, ToolSettings>;
  delegation: { maxConcurrent: number; maxDepth: number };
  browser: { headless: boolean; userDataDir: string; idleMinutes: number };
  gateway: {
    host: string;
    port: number;
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
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  maxTurns: 50,
  requestTimeoutMs: 120_000,
  tokenEstimateCharsPerToken: 4,
  budget: { systemMax: 20_000, historyMax: 180_000, toolsMax: 30_000, outputReserve: 16_000 },
  retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  runtime: { maxConcurrentTurns: 4 },
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
  const config: TaiweiConfig = {
    ...DEFAULT_CONFIG,
    ...storedConfig,
    customPrompt: typeof storedConfig.customPrompt === 'string' ? storedConfig.customPrompt : DEFAULT_CONFIG.customPrompt,
    compressThreshold: resolveCompressThreshold({ ...DEFAULT_CONFIG, ...storedConfig } as TaiweiConfig),
    memoryFlush: typeof storedConfig.memoryFlush === 'boolean' ? storedConfig.memoryFlush : DEFAULT_CONFIG.memoryFlush,
    hookTimeoutSeconds: normalizeHookTimeout(storedConfig.hookTimeoutSeconds),
    hooks: normalizeHooks(storedConfig.hooks),
    autoLoadSkills: storedConfig.autoLoadSkills ?? DEFAULT_CONFIG.autoLoadSkills,
    skillsDisabled: normalizeStringList(storedConfig.skillsDisabled),
    tools: normalizeToolSettings(storedConfig.tools),
    delegation: { ...DEFAULT_CONFIG.delegation, ...storedConfig.delegation },
    budget: { ...DEFAULT_CONFIG.budget, ...storedConfig.budget },
    retry: { ...DEFAULT_CONFIG.retry, ...storedConfig.retry },
    runtime: { ...DEFAULT_CONFIG.runtime, ...storedConfig.runtime },
    policy: { rules: Array.isArray(storedConfig.policy?.rules) ? storedConfig.policy.rules : [] },
    browser: { ...DEFAULT_CONFIG.browser, ...storedConfig.browser },
    gateway: { ...DEFAULT_CONFIG.gateway, ...storedConfig.gateway },
    auth: { ...DEFAULT_CONFIG.auth, ...storedConfig.auth },
    oauth: { ...DEFAULT_CONFIG.oauth, ...storedConfig.oauth },
    share: { ...DEFAULT_CONFIG.share, ...storedConfig.share },
    workspace: { ...DEFAULT_CONFIG.workspace, ...storedConfig.workspace },
    security: {
      ...DEFAULT_CONFIG.security,
      ...stored.security,
      patterns: [...(stored.security?.patterns ?? DEFAULT_CONFIG.security.patterns)],
      approvedPatterns: [...(stored.security?.approvedPatterns ?? DEFAULT_CONFIG.security.approvedPatterns)],
    },
    apiKey: stored.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseUrl: stored.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    model: stored.model ?? DEFAULT_CONFIG.model,
    embedModel: stored.embedModel ?? DEFAULT_CONFIG.embedModel,
  };
  const storedPassword = config.auth.password;
  const diskPassword = passwordForStorage(storedPassword);
  if (diskPassword !== storedPassword) {
    config.auth.password = diskPassword;
    await saveConfig(config);
  }
  config.apiKey = process.env.TAIWEI_API_KEY ?? config.apiKey;
  config.baseUrl = process.env.TAIWEI_BASE_URL ?? config.baseUrl;
  config.model = process.env.TAIWEI_MODEL ?? config.model;
  if (process.env.TAIWEI_AUTH_PASSWORD !== undefined) config.auth.password = process.env.TAIWEI_AUTH_PASSWORD;
  if (process.env.OAUTH_TAIWEI_SECRET !== undefined) config.oauth.clientSecret = process.env.OAUTH_TAIWEI_SECRET;
  if (process.env.OAUTH_TAIWEI_REDIRECT !== undefined) config.oauth.redirectUri = process.env.OAUTH_TAIWEI_REDIRECT;
  return config;
}

export async function saveConfig(config: TaiweiConfig): Promise<void> {
  const paths = await ensureTaiweiHome();
  const { guests: _ignoredGuests, ...configWithoutGuests } = config as TaiweiConfig & { guests?: unknown };
  const stored = {
    ...configWithoutGuests,
    auth: { ...config.auth, password: passwordForStorage(config.auth.password) },
  };
  await writeFile(paths.config, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
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
      hookTimeoutSeconds: normalizeHookTimeout(storedConfig.hookTimeoutSeconds),
      hooks: normalizeHooks(storedConfig.hooks),
      skillsDisabled: normalizeStringList(storedConfig.skillsDisabled),
      tools: normalizeToolSettings(storedConfig.tools),
      delegation: { ...DEFAULT_CONFIG.delegation, ...storedConfig.delegation },
      budget: { ...DEFAULT_CONFIG.budget, ...storedConfig.budget },
      retry: { ...DEFAULT_CONFIG.retry, ...storedConfig.retry },
      runtime: { ...DEFAULT_CONFIG.runtime, ...storedConfig.runtime },
      policy: { rules: Array.isArray(storedConfig.policy?.rules) ? storedConfig.policy.rules : [] },
      browser: { ...DEFAULT_CONFIG.browser, ...storedConfig.browser },
      gateway: { ...DEFAULT_CONFIG.gateway, ...storedConfig.gateway },
      auth: { ...DEFAULT_CONFIG.auth, ...storedConfig.auth },
      oauth: { ...DEFAULT_CONFIG.oauth, ...storedConfig.oauth },
      share: { ...DEFAULT_CONFIG.share, ...storedConfig.share },
      workspace: { ...DEFAULT_CONFIG.workspace, ...storedConfig.workspace },
      security: {
        ...DEFAULT_CONFIG.security,
        ...stored.security,
        patterns: [...(stored.security?.patterns ?? DEFAULT_CONFIG.security.patterns)],
        approvedPatterns: [...(stored.security?.approvedPatterns ?? DEFAULT_CONFIG.security.approvedPatterns)],
      },
    };
    config.auth.password = passwordForStorage(config.auth.password);
    await saveConfig(config);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await saveConfig(DEFAULT_CONFIG);
    return {
      ...DEFAULT_CONFIG,
      hooks: normalizeHooks(),
      delegation: { ...DEFAULT_CONFIG.delegation }, browser: { ...DEFAULT_CONFIG.browser },
      budget: { ...DEFAULT_CONFIG.budget }, retry: { ...DEFAULT_CONFIG.retry }, runtime: { ...DEFAULT_CONFIG.runtime }, policy: { rules: [] },
      gateway: { ...DEFAULT_CONFIG.gateway },
      auth: { ...DEFAULT_CONFIG.auth },
      oauth: { ...DEFAULT_CONFIG.oauth },
      share: { ...DEFAULT_CONFIG.share },
      workspace: { ...DEFAULT_CONFIG.workspace },
      security: { ...DEFAULT_CONFIG.security, patterns: [], approvedPatterns: [] },
    };
  }
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
