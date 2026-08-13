import { readFile, writeFile } from 'node:fs/promises';
import { ensureTaiweiHome } from '../util/paths.js';

export interface TaiweiConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTurns: number;
  requestTimeoutMs: number;
  gateway: {
    host: string;
    port: number;
  };
}

export const DEFAULT_CONFIG: TaiweiConfig = {
  model: 'gpt-4.1-mini',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  maxTurns: 50,
  requestTimeoutMs: 120_000,
  gateway: {
    host: '127.0.0.1',
    port: 8688,
  },
};

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
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    gateway: { ...DEFAULT_CONFIG.gateway, ...stored.gateway },
    apiKey: process.env.TAIWEI_API_KEY ?? stored.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseUrl: process.env.TAIWEI_BASE_URL ?? stored.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    model: process.env.TAIWEI_MODEL ?? stored.model ?? DEFAULT_CONFIG.model,
  };
}

export async function saveConfig(config: TaiweiConfig): Promise<void> {
  const paths = await ensureTaiweiHome();
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function initializeConfig(): Promise<TaiweiConfig> {
  const paths = await ensureTaiweiHome();
  try {
    const stored = JSON.parse(await readFile(paths.config, 'utf8')) as Partial<TaiweiConfig>;
    const config = { ...DEFAULT_CONFIG, ...stored, gateway: { ...DEFAULT_CONFIG.gateway, ...stored.gateway } };
    await saveConfig(config);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

export async function setModel(model: string): Promise<TaiweiConfig> {
  const config = await loadConfig();
  config.model = model;
  await saveConfig(config);
  return config;
}
