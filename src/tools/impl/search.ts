import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolSpec } from '../registry.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { assertGuestPathNotSensitive, redactCredentialText } from '../../security/sensitive-paths.js';

const execFileAsync = promisify(execFile);

export const searchTool: ToolSpec = {
  name: 'search_files',
  description: 'Search file contents using ripgrep.',
  parameters: {
    type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
    required: ['query'], additionalProperties: false,
  },
  configSchema: {
    maxResults: { type: 'number', default: 50, label: '最大结果数', description: '限制返回给模型的匹配行数。', min: 1, max: 1000 },
  },
  async execute(args, context) {
    const rgArgs = ['--line-number', '--no-heading', '--color', 'never'];
    if (args.glob) rgArgs.push('--glob', String(args.glob));
    const searchPath = context.workspaceOnly
      ? await resolveInWorkspace(String(args.path ?? '.'), context.workspaceRoot ?? context.cwd)
      : String(args.path ?? '.');
    if (context.role === 'guest') assertGuestPathNotSensitive(searchPath);
    rgArgs.push('--', String(args.query), searchPath);
    try {
      const result = await execFileAsync('rg', rgArgs, { cwd: context.cwd, signal: context.signal, maxBuffer: 10 * 1024 * 1024 });
      const maxResults = Math.max(1, Math.floor(Number(context.toolConfig?.maxResults ?? 50)));
      const output = result.stdout.split(/(?<=\n)/).slice(0, maxResults).join('');
      return context.role === 'guest' ? redactCredentialText(output) : output;
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string };
      if (failed.code === 1) return '';
      throw error;
    }
  },
};
