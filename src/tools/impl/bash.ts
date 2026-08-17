import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ToolSpec } from '../registry.js';
import { expandHome } from '../../config/config.js';
import { resolveInWorkspace } from '../../util/paths.js';

const execFileAsync = promisify(execFile);

const GUEST_DENIAL = 'guest 只能操作自己的工作目录';
const SYSTEM_COMMAND = /\b(?:sudo|su|useradd|userdel|passwd|chown|chmod|mount|umount|iptables|systemctl|reboot|shutdown|halt|poweroff|docker|kubectl|crontab)\b/i;
const FILESYSTEM_COMMAND = /(?:^|[;&|()\n]\s*)(?:cat|ls|rm|cp|mv|touch|mkdir|rmdir|find|grep|rg|sed|awk|head|tail|tee|readlink|stat|tar|zip|unzip|dd|file|du|df|ln|realpath|cd)\b/i;

function commandWords(command: string): string[] {
  return command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s;&|()<>]+/g)?.map((word) => {
    const unquoted = ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) ? word.slice(1, -1) : word;
    const equals = unquoted.indexOf('=');
    return equals >= 0 ? unquoted.slice(equals + 1) : unquoted;
  }).filter(Boolean) ?? [];
}

/**
 * Guest shell is defense-in-depth rather than a general shell sandbox: its cwd
 * and recognizable filesystem paths must stay under the guest workspace, and
 * system-administration commands are rejected outright.
 */
export async function constrainGuestBash(command: string, cwd: string, workspaceRoot?: string): Promise<{ error: string; command: string; cwd: string } | undefined> {
  if (!workspaceRoot) return undefined;
  try { await resolveInWorkspace(cwd, workspaceRoot); }
  catch { return { error: GUEST_DENIAL, command, cwd }; }

  if (SYSTEM_COMMAND.test(command) || /\bnohup\b[^\n]*&\s*(?:$|[;])/i.test(command)) {
    return { error: `${GUEST_DENIAL}：禁止系统级命令`, command, cwd };
  }
  const touchesFilesystem = FILESYSTEM_COMMAND.test(command) || /[<>]/.test(command);
  const words = commandWords(command);
  const embeddedPaths = command.match(/(?:^|[\s'"=:(])((?:~(?:\/|$)|\/)[^\s'";&|()<>]*)/g)?.map((match) => match.trim().replace(/^['"=:(]+/, '')) ?? [];
  for (const rawWord of [...words, ...embeddedPaths]) {
    const word = rawWord.replace(/^["']|["',:]$/g, '');
    if (!word || word.startsWith('-')) continue;
    if (touchesFilesystem && (word.includes('$') || word.includes('`') || /[*?\[\]]/.test(word))) {
      return { error: `${GUEST_DENIAL}：无法安全解析路径`, command, cwd };
    }
    const explicitlyPathLike = word.startsWith('/') || word.startsWith('~') || word === '..' || word.startsWith('../');
    if (!touchesFilesystem && !explicitlyPathLike) continue;
    const candidate = word.startsWith('~') ? expandHome(word) : resolve(cwd, word);
    try { await resolveInWorkspace(candidate, workspaceRoot); }
    catch { return { error: `${GUEST_DENIAL}：路径越界`, command, cwd }; }
  }
  return undefined;
}

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
    if (context.role === 'guest' && context.workspaceRoot) {
      const denial = await constrainGuestBash(command, cwd, context.workspaceRoot);
      if (denial) return denial;
    } else if (configuredCwd) {
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
