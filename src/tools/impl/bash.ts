import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolSpec } from '../registry.js';

const execFileAsync = promisify(execFile);

export const bashTool: ToolSpec = {
  name: 'bash',
  description: 'Run a shell command in the current working directory.',
  parameters: {
    type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
    required: ['command'], additionalProperties: false,
  },
  async execute(args, context) {
    const result = await execFileAsync(process.env.SHELL || '/bin/sh', ['-lc', String(args.command)], {
      cwd: context.cwd,
      signal: context.signal,
      timeout: Number(args.timeout_ms ?? 120_000),
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};
