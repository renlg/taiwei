import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';

export const readTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a UTF-8 text file.',
  parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  },
  async execute(args, context) {
    const path = context.workspaceOnly
      ? await resolveInWorkspace(String(args.path), context.workspaceRoot ?? context.cwd)
      : resolve(context.cwd, String(args.path));
    return readFile(path, 'utf8');
  },
};
