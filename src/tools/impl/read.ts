import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { assertGuestPathNotSensitive, redactCredentialText } from '../../security/sensitive-paths.js';

export const readTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a UTF-8 text file. Supports optional pagination via offset (1-based start line) and limit (number of lines). When offset or limit is provided, output includes line numbers in "NNN | content" format.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number', description: 'Start line number (1-based). Lines before this are skipped.' },
      limit: { type: 'number', description: 'Maximum number of lines to return.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = context.workspaceOnly
      ? await resolveInWorkspace(String(args.path), context.workspaceRoot ?? context.cwd)
      : resolve(context.cwd, String(args.path));
    if (context.role === 'guest') assertGuestPathNotSensitive(path);

    const offset = args.offset != null ? Math.max(1, Number(args.offset)) : undefined;
    const limit = args.limit != null ? Math.max(1, Number(args.limit)) : undefined;

    if (offset === undefined && limit === undefined) {
      const content = await readFile(path, 'utf8');
      return context.role === 'guest' ? redactCredentialText(content) : content;
    }

    const full = await readFile(path, 'utf8');
    const allLines = full.split('\n');
    const startIdx = (offset ?? 1) - 1;
    const endIdx = limit != null ? Math.min(allLines.length, startIdx + limit) : allLines.length;
    const slice = allLines.slice(startIdx, endIdx);

    const output = slice
      .map((line, i) => `${String(startIdx + i + 1).padStart(String(endIdx).length, ' ')} | ${line}`)
      .join('\n');
    return context.role === 'guest' ? redactCredentialText(output) : output;
  },
};
