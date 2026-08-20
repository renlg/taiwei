import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ToolSpec } from '../registry.js';
import { expandHome } from '../../config/config.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { osUserForGuest, giteaTokenFor } from '../../gateway/tenant-os.js';

const execFileAsync = promisify(execFile);

type BashExecution = { stdout: string; stderr: string };
type BashExecutor = (file: string, args: string[], options: {
  cwd: string; signal?: AbortSignal; timeout: number; maxBuffer: number;
}) => Promise<BashExecution>;

export interface BashToolDependencies {
  executeFile?: BashExecutor;
  lookupOsUser?: (username: string) => Promise<string | undefined>;
  lookupGiteaToken?: (username: string) => Promise<string | undefined>;
  isRoot?: () => boolean;
  warn?: (message: string) => void;
}

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

/** 读取 cwd/.git/config 里 origin remote 的 owner（仓库属主）。无 .git 或无 remote 返回 undefined。 */
async function readGitConfig(cwd: string): Promise<{ remoteOwner?: string } | undefined> {
  let configText: string;
  try {
    configText = await readFile(resolve(cwd, '.git/config'), 'utf8');
  } catch {
    return undefined;
  }
  const remoteMatch = configText.match(/\[remote\s+"?origin"?\]\s*([\s\S]*?)(?=\n\[|$)/);
  if (!remoteMatch) return undefined;
  const urlLine = remoteMatch[1].match(/^\s*url\s*=\s*(.+)$/m);
  if (!urlLine) return undefined;
  const url = urlLine[1].trim();
  const ownerMatch = url.match(/https?:\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\//);
  return ownerMatch ? { remoteOwner: decodeURIComponent(ownerMatch[1]) } : undefined;
}

/**
 * Guest git 强制安全层：
 * 1. git commit 强制使用当前用户的 Gitea 身份（guestN），覆盖任何用户设的 user.name/user.email；
 * 2. git push/clone/fetch/pull 只允许访问当前用户自己的账号（guestN）或专属组织（guestN-org），
 *    其余 owner（admin、其他 guestN、陌生组织）一律拒绝 —— 防止用非本用户账号提交/部署；
 * 3. push URL 自动注入当前用户自己的 token（从 SQLite gitea_api_token 取，不落盘）。
 * 返回 { command } 为改写后的安全命令，或 { error } 拒绝执行。
 */
async function enforceGuestGit(
  command: string,
  username: string,
  guestOsUser: string,
  cwd: string,
  lookupToken: (username: string) => Promise<string | undefined>,
): Promise<{ command: string } | { error: string }> {
  // 仅处理包含 git 的 bash 命令；非 git 命令不干预
  if (!/^[^;&|()]*\bgit\b/.test(command)) return { command };

  const token = await lookupToken(username);
  if (!token) return { error: `${GUEST_DENIAL}：无法获取 ${username} 的 Gitea token，禁止 git 远程操作` };

  const guestOrg = `${guestOsUser}-org`;

  // 校验远程 URL 的 owner 必须是本用户（guestN 或 guestN-org）
  const validateRemote = (url: string): string | undefined => {
    const match = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!match) return undefined; // 非标准 URL，交由 git 自行处理（如本地路径）
    const host = match[1];
    const owner = decodeURIComponent(match[2]);
    const repo = match[3];
    if (owner === guestOsUser || owner === guestOrg) {
      // 重写为带本用户 token 的 URL（token 不落盘，仅存在命令串）
      return `http://${guestOsUser}:${token}@${host}/${owner}/${repo}.git`;
    }
    return `DENY:${owner}`;
  };

  const rewriteOwnRemote = (cmd: string): { ok: string } | { deny: string } => {
    const remoteMatch = cmd.match(/\bgit\s+remote\s+(?:add|set-url)\s+[^\s]+\s+(\S+)/);
    if (remoteMatch) {
      const rewritten = validateRemote(remoteMatch[1]);
      if (!rewritten) return { ok: cmd };
      if (rewritten.startsWith('DENY:')) return { deny: rewritten.slice(5) };
      return { ok: cmd.replace(remoteMatch[1], rewritten) };
    }
    return { ok: cmd };
  };

  // 校验 push/clone 的 URL 或默认 remote
  const urlMatch = command.match(/\bgit\s+(?:push|clone|fetch|pull)\b[^|;&\n]*(?:\s+(https?:\/\/\S+))?/);
  if (urlMatch) {
    if (urlMatch[1]) {
      const rewritten = validateRemote(urlMatch[1]);
      if (!rewritten) return { error: `${GUEST_DENIAL}：无法解析远程仓库地址，禁止 git 远程操作` };
      if (rewritten.startsWith('DENY:')) {
        return { error: `${GUEST_DENIAL}：git 远程仓库必须属于你本人（${guestOsUser} 或 ${guestOrg}），不能使用其他账号（${rewritten.slice(5)}）的仓库` };
      }
      return { command: command.replace(urlMatch[1], rewritten) };
    }
    // 无显式 URL：走默认 remote origin —— 校验 .git/config 里的 remote 必须指向本人仓库
    const config = await readGitConfig(cwd);
    if (!config) return { command }; // 无 .git/config（clone 场景还没 config），交给 git 处理
    const owner = config.remoteOwner;
    if (owner && owner !== guestOsUser && owner !== guestOrg) {
      return { error: `${GUEST_DENIAL}：git 默认 remote 必须属于你本人（${guestOsUser} 或 ${guestOrg}），当前指向其他账号（${owner}）的仓库，禁止远程操作` };
    }
    return { command };
  }

  const remoteResult = rewriteOwnRemote(command);
  if ('deny' in remoteResult) {
    return { error: `${GUEST_DENIAL}：git remote 必须指向你本人（${guestOsUser} 或 ${guestOrg}），不能使用其他账号（${remoteResult.deny}）的仓库` };
  }
  let out = remoteResult.ok;

  // git commit 强制身份（覆盖任何 user.name/user.email 设置）
  const commitMatch = out.match(/\bgit\s+commit\b/);
  if (commitMatch) {
    out = out.replace(/\bgit\s+commit\b/,
      `git -c user.name=${guestOsUser} -c user.email=${guestOsUser}@taiwei.local commit`);
  }

  return { command: out };
}

export function createBashTool(dependencies: BashToolDependencies = {}): ToolSpec {
  const executeFile = dependencies.executeFile ?? execFileAsync as BashExecutor;
  const lookupOsUser = dependencies.lookupOsUser ?? osUserForGuest;
  const lookupGiteaToken = dependencies.lookupGiteaToken ?? giteaTokenFor;
  const isRoot = dependencies.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0);
  const warn = dependencies.warn ?? console.warn;
  return {
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
      let command = String(args.command);
      const configuredCwd = String(context.toolConfig?.defaultCwd ?? '').trim();
      const cwd = configuredCwd ? (configuredCwd.startsWith('~') ? expandHome(configuredCwd) : resolve(context.cwd, configuredCwd)) : context.cwd;
      if (context.role === 'guest') {
        if (context.workspaceRoot) {
          const denial = await constrainGuestBash(command, cwd, context.workspaceRoot);
          if (denial) return denial;
        }
        let guestOsUser: string | undefined;
        let lookupFailed = false;
        try { guestOsUser = context.identity ? await lookupOsUser(context.identity) : undefined; }
        catch (error) {
          lookupFailed = true;
          warn(`[taiwei] OS account lookup failed for guest ${context.identity ?? '<unknown>'}; bash is using the current process user: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (guestOsUser && isRoot()) {
          if (context.authorizeCommand && !await context.authorizeCommand(command, cwd)) {
            return { error: '用户拒绝了该命令的执行', command, cwd };
          }
          // 强制 git 安全层：commit 用本用户身份，push/clone/fetch/pull 只能访问本用户仓库，自动注入本用户 token
          if (context.identity) {
            const enforced = await enforceGuestGit(command, context.identity, guestOsUser, cwd, lookupGiteaToken);
            if ('error' in enforced) return { error: enforced.error, command, cwd };
            command = enforced.command;
          }
          const result = await executeFile('runuser', ['-u', guestOsUser, '--', '/bin/bash', '-lc', command], {
            cwd, signal: context.signal, timeout: Number(args.timeout_ms ?? 120_000), maxBuffer: 10 * 1024 * 1024,
          });
          return { stdout: result.stdout, stderr: result.stderr };
        }
        if (!lookupFailed) warn(guestOsUser
            ? `[taiwei] gateway is not running as root; guest bash for ${guestOsUser} is using the current process user`
            : `[taiwei] no OS account mapping found for guest ${context.identity ?? '<unknown>'}; bash is using the current process user`);
      } else if (configuredCwd) {
        try { await resolveInWorkspace(cwd, context.workspaceRoot ?? context.cwd); }
        catch { console.warn(`[taiwei] bash defaultCwd is outside the workspace (${cwd}); command execution is not jailed`); }
      }
      if (context.authorizeCommand && !await context.authorizeCommand(command, cwd)) {
        return { error: '用户拒绝了该命令的执行', command, cwd };
      }
      const result = await executeFile(process.env.SHELL || '/bin/sh', ['-lc', String(args.command)], {
        cwd,
        signal: context.signal,
        timeout: Number(args.timeout_ms ?? 120_000),
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export const bashTool: ToolSpec = createBashTool();
