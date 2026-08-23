import type { ProviderConfig } from './providers/types.js';

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindow: number;
}

export interface ModelDef {
  id: string;
  provider: string;
  displayName: string;
  capabilities: ModelCapabilities;
  adminOnly?: boolean;
  costPerMIn?: number;
  costPerMOut?: number;
}

export interface ModelSelection { providerId: string; modelId: string; }

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 256_000,
};

export function normalizeModel(provider: ProviderConfig, value: ModelDef | string): ModelDef {
  if (typeof value !== 'string') return {
    ...value,
    provider: provider.id,
    displayName: value.displayName || value.id,
    capabilities: { ...DEFAULT_CAPABILITIES, ...value.capabilities },
  };
  return { id: value, provider: provider.id, displayName: value, capabilities: { ...DEFAULT_CAPABILITIES }, adminOnly: undefined };
}

export function providerModels(provider: ProviderConfig): ModelDef[] {
  const configured = provider.models ?? [];
  const models = [...new Map(configured.map((model) => normalizeModel(provider, { ...model, id: model.id.trim() }))
    .filter((model) => Boolean(model.id)).map((model) => [model.id, model])).values()];
  if (provider.defaultModel && !models.some((model) => model.id === provider.defaultModel)) {
    models.unshift(normalizeModel(provider, provider.defaultModel));
  }
  return models;
}

export function findProvider(providers: ProviderConfig[], id: string): ProviderConfig {
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function resolveModel(providers: ProviderConfig[], selection: ModelSelection): { provider: ProviderConfig; model: ModelDef } {
  const provider = findProvider(providers, selection.providerId);
  const model = providerModels(provider).find((candidate) => candidate.id === selection.modelId)
    ?? normalizeModel(provider, selection.modelId);
  return { provider, model };
}

export function filterToolsForModel<T>(tools: T[], model: Pick<ModelDef, 'capabilities'>): T[] {
  return model.capabilities.tools ? tools : [];
}
