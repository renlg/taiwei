import type { ToolSpec } from '../registry.js';
import { retrieve } from '../../rag/retrieve.js';

export const ragSearchTool: ToolSpec = {
  name: 'rag_search',
  description: 'Search the local indexed knowledge base with BM25 keyword retrieval.',
  parameters: {
    type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } },
    required: ['query'], additionalProperties: false,
  },
  execute: (args) => retrieve(String(args.query), Number(args.limit ?? 5)),
};
