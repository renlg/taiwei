import { loadConfig, saveConfig, type TaiweiConfig } from './config.js';

const MODEL_LIST_TIMEOUT_MS = 8_000;

export type ModelListSource = 'config' | 'upstream' | 'fallback';

export interface ModelListResult {
  models: string[];
  current: string;
  source: ModelListSource;
}

function uniqueNames(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

export async function getCurrentModel(): Promise<string> {
  return (await loadConfig()).model;
}

export async function setCurrentModel(name: string): Promise<TaiweiConfig> {
  const model = name.trim();
  if (!model) throw new Error('model must be a non-empty string');
  const config = await loadConfig();
  config.model = model;
  await saveConfig(config);
  return config;
}

export async function resolveModels(): Promise<ModelListResult> {
  const config = await loadConfig();
  const current = config.model;
  if (Array.isArray(config.models)) {
    const models = uniqueNames(config.models);
    return { models: models.length ? models : [current], current, source: models.length ? 'config' : 'fallback' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Provider returned ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> } | Array<{ id?: unknown }>;
    const entries = Array.isArray(body) ? body : body.data;
    const models = uniqueNames((entries ?? []).map((item) => item?.id));
    if (!models.length) throw new Error('Provider returned no models');
    return { models, current, source: 'upstream' };
  } catch {
    return { models: [current], current, source: 'fallback' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listModels(): Promise<string[]> {
  return (await resolveModels()).models;
}
