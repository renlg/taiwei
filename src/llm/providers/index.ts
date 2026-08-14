import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { ProviderAdapter, ProviderType } from './types.js';

const adapters = new Map<ProviderType, ProviderAdapter>([
  ['openai-compatible', new OpenAICompatibleAdapter()],
  ['anthropic', new AnthropicAdapter()],
]);

export function providerAdapter(type: ProviderType): ProviderAdapter {
  const adapter = adapters.get(type);
  if (!adapter) throw new Error(`Provider type "${type}" is configured but its adapter is not implemented`);
  return adapter;
}
