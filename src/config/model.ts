import { loadConfig, saveConfig, type TaiweiConfig } from './config.js';

export type ModelListSource = 'config' | 'fallback';

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
  const models = Array.isArray(config.models) ? uniqueNames(config.models) : [];
  return { models: models.length ? models : [current], current, source: models.length ? 'config' : 'fallback' };
}

export async function listModels(): Promise<string[]> {
  return (await resolveModels()).models;
}
