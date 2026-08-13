import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';

export const readTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a UTF-8 text file.',
  parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  },
  async execute(args, context) {
    const path = resolve(context.cwd, String(args.path));
    return readFile(path, 'utf8');
  },
};
