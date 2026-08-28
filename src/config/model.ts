import { loadConfig, saveConfig, type TaiweiConfig } from './config.js';
import { DEFAULT_CAPABILITIES, providerModels, type ModelDef, type ModelSelection } from '../llm/catalog.js';
import type { ProviderConfig } from '../llm/providers/types.js';

export type ModelListSource = 'config' | 'fallback';

export interface ModelListResult {
  models: string[];
  current: string;
  source: ModelListSource;
  providers?: Array<{
    id: string;
    name: string;
    modality?: ProviderConfig['modality'];
    defaultModel?: string;
    models: ReturnType<typeof providerModels>;
  }>;
  currentProvider?: string;
}

export type PublicProviderConfig = Omit<ProviderConfig, 'apiKey'> & { apiKey: string; hasKey: boolean };

export function maskApiKey(apiKey?: string): string {
  const value = apiKey?.trim() ?? '';
  if (!value) return '';
  if (value.length <= 4) return '***';
  const prefix = value.startsWith('sk-') ? 'sk-' : value.slice(0, 3);
  return `${prefix}***${value.slice(-4)}`;
}

export function publicProvider(provider: ProviderConfig): PublicProviderConfig {
  return { ...provider, apiKey: maskApiKey(provider.apiKey), hasKey: Boolean(provider.apiKey?.trim()) };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeManagedModel(value: unknown, providerId: string): ModelDef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('models must contain objects');
  const candidate = value as Partial<ModelDef>;
  const id = requiredString(candidate.id, 'model.id');
  const capabilities = candidate.capabilities && typeof candidate.capabilities === 'object'
    ? candidate.capabilities as Partial<ModelDef['capabilities']> : {};
  const contextWindow = capabilities.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow < 1) {
    throw new Error('model.capabilities.contextWindow must be a positive number');
  }
  return {
    id,
    provider: providerId,
    displayName: typeof candidate.displayName === 'string' && candidate.displayName.trim() ? candidate.displayName.trim() : id,
    capabilities: {
      tools: typeof capabilities.tools === 'boolean' ? capabilities.tools : DEFAULT_CAPABILITIES.tools,
      vision: typeof capabilities.vision === 'boolean' ? capabilities.vision : DEFAULT_CAPABILITIES.vision,
      reasoning: typeof capabilities.reasoning === 'boolean' ? capabilities.reasoning : DEFAULT_CAPABILITIES.reasoning,
      streaming: typeof capabilities.streaming === 'boolean' ? capabilities.streaming : DEFAULT_CAPABILITIES.streaming,
      contextWindow: Math.floor(contextWindow),
    },
    ...(typeof candidate.adminOnly === 'boolean' ? { adminOnly: candidate.adminOnly } : {}),
    ...(typeof candidate.costPerMIn === 'number' ? { costPerMIn: candidate.costPerMIn } : {}),
    ...(typeof candidate.costPerMOut === 'number' ? { costPerMOut: candidate.costPerMOut } : {}),
  };
}

/** Validate an admin-supplied provider while preserving secrets represented by a mask or empty value. */
export function managedProvider(value: unknown, existing?: ProviderConfig): ProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider must be an object');
  const candidate = value as Partial<ProviderConfig>;
  const id = requiredString(candidate.id, 'id');
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('id must match [a-z0-9-]{1,64}');
  if (candidate.type !== 'openai-compatible') throw new Error('type must be openai-compatible');
  const models = Array.isArray(candidate.models) ? candidate.models.map((model) => normalizeManagedModel(model, id)) : [];
  if (!models.length) throw new Error('at least one model is required');
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('model ids must be unique');
  const defaultModel = requiredString(candidate.defaultModel, 'defaultModel');
  if (!models.some((model) => model.id === defaultModel)) throw new Error('defaultModel must reference a configured model');
  const suppliedKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : '';
  const keepExistingKey = !suppliedKey || (existing && suppliedKey === maskApiKey(existing.apiKey));
  const modality = candidate.modality ?? existing?.modality;
  if (modality !== undefined && !['text', 'image', 'video'].includes(modality)) {
    throw new Error('modality must be text, image, or video');
  }
  return {
    id,
    name: requiredString(candidate.name, 'name'),
    type: 'openai-compatible',
    baseUrl: requiredString(candidate.baseUrl, 'baseUrl').replace(/\/$/, ''),
    apiKey: keepExistingKey ? existing?.apiKey ?? '' : suppliedKey,
    defaultModel,
    models,
    ...(modality ? { modality } : {}),
  };
}

export function applyDefaultProvider(config: TaiweiConfig, providerId: string): void {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) throw new Error(`Unknown default provider: ${providerId}`);
  config.defaultProvider = provider.id;
  config.model = provider.defaultModel ?? providerModels(provider)[0]?.id ?? config.model;
  config.baseUrl = provider.baseUrl;
  config.apiKey = provider.apiKey ?? '';
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
  // 只暴露文本模型（modality 缺省为 text）；图片/视频生成 provider 不进模型选择器
  const textProviders = config.providers.filter((provider) => (provider.modality ?? 'text') === 'text');
  return { ...legacy, source: config.providers.length ? 'config' : legacy.source, currentProvider: config.defaultProvider,
    models: config.providers.length ? [] : legacy.models,
    providers: textProviders.map((provider) => ({
      id: provider.id, name: provider.name, modality: provider.modality,
      defaultModel: provider.defaultModel, models: providerModels(provider),
    })) };
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
