import type { TaiweiConfig } from '../config/config.js';
import type { ModelListResult } from '../config/model.js';
import { HttpError } from './http.js';

export type CatalogProvider = NonNullable<ModelListResult['providers']>[number];
const GUEST_MODEL_IDS = new Set(['free', 'good']);

export function modelForSelection(listed: ModelListResult, providerId: string | undefined, modelId: string) {
  return listed.providers?.find((provider) => provider.id === providerId)?.models.find((model) => model.id === modelId);
}

export function modelAllowedForRole(role: 'admin' | 'guest', provider: CatalogProvider | undefined, modelId: string, grantedModelIds: ReadonlySet<string> = new Set()): boolean {
  if (provider && (provider.modality ?? 'text') !== 'text') return false;
  if (role === 'guest' && !GUEST_MODEL_IDS.has(modelId) && !grantedModelIds.has(modelId)) return false;
  return provider ? provider.models.some((model) => model.id === modelId) : true;
}

export function firstAllowedModel(listed: ModelListResult, role: 'admin' | 'guest', grantedModelIds: ReadonlySet<string> = new Set()): { model: string; provider?: string } | undefined {
  for (const provider of listed.providers ?? []) {
    const defaultModel = provider.defaultModel
      ? provider.models.find((candidate) => candidate.id === provider.defaultModel
        && modelAllowedForRole(role, provider, candidate.id, grantedModelIds))
      : undefined;
    if (defaultModel) return { model: defaultModel.id, provider: provider.id };
    const model = provider.models.find((candidate) => modelAllowedForRole(role, provider, candidate.id, grantedModelIds));
    if (model) return { model: model.id, provider: provider.id };
  }
  const model = listed.models.find((candidate) => modelAllowedForRole(role, undefined, candidate, grantedModelIds));
  return model ? { model } : undefined;
}

export function catalogForRole(listed: ModelListResult, role: 'admin' | 'guest', grantedModelIds: ReadonlySet<string> = new Set()): ModelListResult {
  const providerModelIds = new Set(listed.providers?.flatMap((provider) => provider.models.map((model) => model.id)) ?? []);
  const models = listed.models.filter((model) => modelAllowedForRole(role, undefined, model, grantedModelIds)
    && (!providerModelIds.has(model) || listed.providers?.some((provider) => modelAllowedForRole(role, provider, model, grantedModelIds))));
  const providers = listed.providers?.map((provider) => {
    const allowedModels = provider.models.filter((model) => modelAllowedForRole(role, provider, model.id, grantedModelIds));
    return {
      ...provider,
      defaultModel: allowedModels.some((model) => model.id === provider.defaultModel) ? provider.defaultModel : undefined,
      models: allowedModels,
    };
  }).filter((provider) => provider.models.length > 0);
  if (!listed.providers) {
    return { ...listed, models, current: models.includes(listed.current) ? listed.current : models[0] ?? '' };
  }

  const currentProvider = providers?.find((provider) => provider.id === listed.currentProvider);
  if (currentProvider?.models.some((model) => model.id === listed.current)) return { ...listed, models, providers };

  const fallback = firstAllowedModel({ ...listed, models, providers }, role, grantedModelIds);
  return {
    ...listed,
    models,
    providers,
    current: fallback?.model ?? '',
    currentProvider: fallback?.provider,
  };
}

export function grantedModelsFor(config: TaiweiConfig, username: string): ReadonlySet<string> {
  const grants = config.modelGrants?.[username];
  return new Set(Array.isArray(grants) ? grants : []);
}

export function validateModelGrants(value: unknown, config: TaiweiConfig): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'grants 必须是 username 到模型列表的对象');
  const adminOnlyModelIds = new Set(config.providers.flatMap((provider) => provider.models ?? [])
    .filter((model) => model.adminOnly === true).map((model) => model.id));
  const entries: Array<[string, string[]]> = [];
  for (const [rawUsername, rawModels] of Object.entries(value as Record<string, unknown>)) {
    const username = rawUsername.trim();
    if (!username) throw new HttpError(400, '授权用户名不能为空');
    if (!Array.isArray(rawModels) || rawModels.some((model) => typeof model !== 'string' || !model.trim())) {
      throw new HttpError(400, `用户 ${username} 的授权必须是非空模型 id 数组`);
    }
    const models = [...new Set(rawModels.map((model) => (model as string).trim()))];
    const invalid = models.find((modelId) => !adminOnlyModelIds.has(modelId));
    if (invalid) throw new HttpError(400, `模型 ${invalid} 不存在或不是 adminOnly 模型`);
    if (models.length) entries.push([username, models]);
  }
  return Object.fromEntries(entries);
}
