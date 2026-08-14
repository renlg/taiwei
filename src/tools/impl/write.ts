import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';

export const writeTool: ToolSpec = {
  name: 'write_file',
  description: 'Write a UTF-8 text file, creating parent directories as needed.',
  parameters: {
    type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  },
  async execute(args, context) {
    const path = context.workspaceOnly
      ? await resolveInWorkspace(String(args.path), context.workspaceRoot ?? context.cwd)
      : resolve(context.cwd, String(args.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(args.content), 'utf8');
    return { ok: true, path };
  },
};
