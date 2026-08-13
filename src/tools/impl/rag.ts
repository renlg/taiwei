import type { ToolSpec } from '../registry.js';
import { retrieve } from '../../rag/retrieve.js';

export const ragSearchTool: ToolSpec = {
  name: 'rag_search',
  description: 'Search the local indexed knowledge base with hybrid BM25 and embedding retrieval.',
  parameters: {
    type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } },
    required: ['query'], additionalProperties: false,
  },
  configSchema: {
    limit: { type: 'number', default: 5, label: '默认结果数', description: '模型未指定 limit 时返回的结果数量。', min: 1, max: 20 },
  },
  execute: (args, context) => retrieve(String(args.query), Number(args.limit ?? context.toolConfig?.limit ?? 5)),
};
