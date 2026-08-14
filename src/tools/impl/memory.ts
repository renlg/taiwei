import type { ToolSpec } from '../registry.js';
import type { MemoryStore } from '../../memory/store.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureTaiweiHome } from '../../util/paths.js';

const MEMORY_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_EXTENDED_MEMORY_CHARS = 20_000;

function turnStore(defaultStore: MemoryStore, context: Parameters<ToolSpec['execute']>[1]): MemoryStore {
  return context.agentContext?.memory ?? defaultStore;
}

export async function writeExtendedMemory(name: string, content: string): Promise<string> {
  if (!MEMORY_NAME.test(name)) throw new Error('name must match [A-Za-z0-9_-]{1,32}');
  if (content.length > MAX_EXTENDED_MEMORY_CHARS) throw new Error(`content must be at most ${MAX_EXTENDED_MEMORY_CHARS} characters`);
  const directory = (await ensureTaiweiHome()).memoryDir;
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.md`);
  await writeFile(path, content, 'utf8');
  return path;
}

async function extendedFiles(): Promise<Array<{ name: string; chars: number }>> {
  const directory = (await ensureTaiweiHome()).memoryDir;
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map(async (entry) => ({
    name: entry.name.slice(0, -3), chars: (await readFile(join(directory, entry.name), 'utf8')).length,
  })));
}

export function createMemoryTools(store: MemoryStore): ToolSpec[] {
  return [
    {
      name: 'memory_read', description: 'Read core memory containing small durable facts injected into every turn.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: (_args, context) => turnStore(store, context).read(),
    },
    {
      name: 'memory_append', description: 'Append a small durable fact to core memory, which is injected into every turn.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      async execute(args, context) { await turnStore(store, context).append(String(args.text)); return { ok: true }; },
    },
    {
      name: 'memory_extend', description: 'Write or replace a larger extended-memory Markdown note. Rebuild the shared RAG index before it becomes searchable.',
      parameters: {
        type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } },
        required: ['name', 'content'], additionalProperties: false,
      },
      async execute(args, context) {
        if (context.agentContext?.extendedMemory === false) throw new Error('Extended memory is unavailable to guests');
        const path = await writeExtendedMemory(String(args.name), String(args.content));
        return { ok: true, path, indexRebuildNeeded: true };
      },
    },
    {
      name: 'memory_list', description: 'List core memory statistics and extended-memory notes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, context) {
        const content = await turnStore(store, context).read();
        return {
          core: { chars: content.length, lines: content ? content.split(/\r\n|\r|\n/).length : 0 },
          extended: context.agentContext?.extendedMemory === false ? [] : await extendedFiles(),
        };
      },
    },
  ];
}
