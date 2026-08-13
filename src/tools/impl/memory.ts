import type { ToolSpec } from '../registry.js';
import type { MemoryStore } from '../../memory/store.js';

export function createMemoryTools(store: MemoryStore): ToolSpec[] {
  return [
    {
      name: 'memory_read', description: 'Read persistent user memory.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => store.read(),
    },
    {
      name: 'memory_append', description: 'Append a durable fact or note to persistent memory.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      async execute(args) { await store.append(String(args.text)); return { ok: true }; },
    },
  ];
}
