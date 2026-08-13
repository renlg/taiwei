import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureTaiweiHome } from '../util/paths.js';
import { HOOK_EVENTS, type HookCommands } from '../hooks/runner.js';
import { passwordForStorage } from './password.js';

export type SecurityRememberMode = 'off' | 'session' | 'permanent';

export interface TaiweiConfig {
  model: string;
  models?: string[];
  contextWindow?: number;
  contextWindows?: Record<string, number>;
  baseUrl: string;
  apiKey: string;
  maxTurns: number;
  requestTimeoutMs: number;
  hookTimeoutSeconds: number;
  hooks: HookCommands;
  gateway: {
    host: string;
    port: number;
  };
  auth: {
    enabled: boolean;
    username: string;
    password: string;
  };
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
  contextWindow: 128_000,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  maxTurns: 50,
  requestTimeoutMs: 120_000,
  hookTimeoutSeconds: 10,
  hooks: {
    beforeMessage: [],
    beforeLLM: [],
    afterLLM: [],
    beforeTool: [],
    afterTool: [],
  },
  gateway: {
    host: '127.0.0.1',
    port: 8688,
  },
  auth: {
    enabled: false,
    username: 'admin',
    password: '',
  },
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
    : DEFAULT_CONFIG.contextWindow ?? 128_000;
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
  const config: TaiweiConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    hookTimeoutSeconds: normalizeHookTimeout(stored.hookTimeoutSeconds),
    hooks: normalizeHooks(stored.hooks),
    gateway: { ...DEFAULT_CONFIG.gateway, ...stored.gateway },
    auth: { ...DEFAULT_CONFIG.auth, ...stored.auth },
    workspace: { ...DEFAULT_CONFIG.workspace, ...stored.workspace },
    security: {
      ...DEFAULT_CONFIG.security,
      ...stored.security,
      patterns: [...(stored.security?.patterns ?? DEFAULT_CONFIG.security.patterns)],
      approvedPatterns: [...(stored.security?.approvedPatterns ?? DEFAULT_CONFIG.security.approvedPatterns)],
    },
    apiKey: stored.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseUrl: stored.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    model: stored.model ?? DEFAULT_CONFIG.model,
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
  return config;
}

export async function saveConfig(config: TaiweiConfig): Promise<void> {
  const paths = await ensureTaiweiHome();
  const stored = {
    ...config,
    auth: { ...config.auth, password: passwordForStorage(config.auth.password) },
  };
  await writeFile(paths.config, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

export async function initializeConfig(): Promise<TaiweiConfig> {
  const paths = await ensureTaiweiHome();
  try {
    const stored = JSON.parse(await readFile(paths.config, 'utf8')) as Partial<TaiweiConfig>;
    const config = {
      ...DEFAULT_CONFIG,
      ...stored,
      hookTimeoutSeconds: normalizeHookTimeout(stored.hookTimeoutSeconds),
      hooks: normalizeHooks(stored.hooks),
      gateway: { ...DEFAULT_CONFIG.gateway, ...stored.gateway },
      auth: { ...DEFAULT_CONFIG.auth, ...stored.auth },
      workspace: { ...DEFAULT_CONFIG.workspace, ...stored.workspace },
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
      gateway: { ...DEFAULT_CONFIG.gateway },
      auth: { ...DEFAULT_CONFIG.auth },
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

export function validateGatewayAuth(config: TaiweiConfig): void {
  if (config.auth.enabled && !config.auth.password) {
    throw new Error('Gateway auth is enabled but no password is set. Set auth.password in ~/.taiwei/config.json or TAIWEI_AUTH_PASSWORD.');
  }
}
