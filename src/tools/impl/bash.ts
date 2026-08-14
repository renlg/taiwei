import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { expandHome } from '../../config/config.js';
import { resolveInWorkspace } from '../../util/paths.js';

const execFileAsync = promisify(execFile);

export const bashTool: ToolSpec = {
  name: 'bash',
  description: 'Run a shell command in the current working directory.',
  parameters: {
    type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
    required: ['command'], additionalProperties: false,
  },
  configSchema: {
    defaultCwd: { type: 'string', default: '', label: '默认工作目录', description: '留空时使用当前工作区。', placeholder: '~/workspace/project' },
  },
  async execute(args, context) {
    const command = String(args.command);
    const configuredCwd = String(context.toolConfig?.defaultCwd ?? '').trim();
    const cwd = configuredCwd ? (configuredCwd.startsWith('~') ? expandHome(configuredCwd) : resolve(context.cwd, configuredCwd)) : context.cwd;
    if (configuredCwd) {
      try { await resolveInWorkspace(cwd, context.workspaceRoot ?? context.cwd); }
      catch { console.warn(`[taiwei] bash defaultCwd is outside the workspace (${cwd}); command execution is not jailed`); }
    }
    if (context.authorizeCommand && !await context.authorizeCommand(command, cwd)) {
      return { error: '用户拒绝了该命令的执行', command, cwd };
    }
    const result = await execFileAsync(process.env.SHELL || '/bin/sh', ['-lc', String(args.command)], {
      cwd,
      signal: context.signal,
      timeout: Number(args.timeout_ms ?? 120_000),
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};
