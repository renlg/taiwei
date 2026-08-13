import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolSpec } from '../registry.js';

const execFileAsync = promisify(execFile);

export const searchTool: ToolSpec = {
  name: 'search_files',
  description: 'Search file contents using ripgrep.',
  parameters: {
    type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
    required: ['query'], additionalProperties: false,
  },
  async execute(args, context) {
    const rgArgs = ['--line-number', '--no-heading', '--color', 'never'];
    if (args.glob) rgArgs.push('--glob', String(args.glob));
    rgArgs.push('--', String(args.query), String(args.path ?? '.'));
    try {
      const result = await execFileAsync('rg', rgArgs, { cwd: context.cwd, signal: context.signal, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout;
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string };
      if (failed.code === 1) return '';
      throw error;
    }
  },
};
