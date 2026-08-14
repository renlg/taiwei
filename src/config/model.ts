import { loadConfig, saveConfig, type TaiweiConfig } from './config.js';
import { providerModels, type ModelSelection } from '../llm/catalog.js';
import type { ProviderConfig } from '../llm/providers/types.js';

export type ModelListSource = 'config' | 'fallback';

export interface ModelListResult {
  models: string[];
  current: string;
  source: ModelListSource;
  providers?: Array<{ id: string; name: string; models: ReturnType<typeof providerModels> }>;
  currentProvider?: string;
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

export async function resolveModelCatalog(): Promise<ModelListResult> {
  const config = await loadConfig(); const legacy = await resolveModels();
  return { ...legacy, source: config.providers.length ? 'config' : legacy.source, currentProvider: config.defaultProvider,
    providers: config.providers.map((provider) => ({ id: provider.id, name: provider.name, models: providerModels(provider) })) };
}

export async function listModels(): Promise<string[]> {
  return (await resolveModels()).models;
}

export function defaultProvider(config: TaiweiConfig): ProviderConfig {
  return config.providers.find((provider) => provider.id === config.defaultProvider) ?? config.providers[0] ?? {
    id: 'default', name: 'Default', type: 'openai-compatible', baseUrl: config.baseUrl, apiKey: config.apiKey,
    defaultModel: config.model,
  };
}

export function selectionFor(config: TaiweiConfig, providerId?: string, modelId?: string): ModelSelection {
  const provider = config.providers.find((candidate) => candidate.id === providerId) ?? defaultProvider(config);
  return { providerId: provider.id, modelId: modelId ?? provider.defaultModel ?? config.model };
}
