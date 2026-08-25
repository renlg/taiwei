import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';

export const writeTool: ToolSpec = {
  name: 'write_file',
  description: 'Write a UTF-8 text file atomically (write-to-temp then rename), creating parent directories as needed.',
  parameters: {
    type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  },
  async execute(args, context) {
    const path = context.workspaceOnly
      ? await resolveInWorkspace(String(args.path), context.workspaceRoot ?? context.cwd)
      : resolve(context.cwd, String(args.path));
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await context.beforeFileWrite?.(path);

    const tmpName = `.${Date.now()}-${randomBytes(4).toString('hex')}.tmp`;
    const tmpPath = join(dir, tmpName);

    try {
      await writeFile(tmpPath, String(args.content), 'utf8');
      await rename(tmpPath, path);
      await context.afterFileWrite?.(path);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }

    return { ok: true, path };
  },
};
