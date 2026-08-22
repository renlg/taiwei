import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ToolSpec } from '../registry.js';
import { expandHome, loadConfig } from '../../config/config.js';
import { resolveInWorkspace } from '../../util/paths.js';
import { osUserForGuest, giteaTokenFor } from '../../gateway/tenant-os.js';
import { assertGuestPathNotSensitive, containsSensitivePathReference, redactCredentialText } from '../../security/sensitive-paths.js';

const execFileAsync = promisify(execFile);

type BashExecution = { stdout: string; stderr: string };
type BashExecutor = (file: string, args: string[], options: {
  cwd: string; signal?: AbortSignal; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv;
}) => Promise<BashExecution>;

export interface BashToolDependencies {
  executeFile?: BashExecutor;
  lookupOsUser?: (username: string) => Promise<string | undefined>;
  lookupGiteaToken?: (username: string) => Promise<string | undefined>;
  lookupGiteaBaseUrl?: () => Promise<string | undefined>;
  isRoot?: () => boolean;
  warn?: (message: string) => void;
}

const GUEST_DENIAL = 'guest 只能操作自己的工作目录';
const SYSTEM_COMMAND = /\b(?:sudo|su|useradd|userdel|passwd|chown|chmod|mount|umount|iptables|systemctl|service|nginx|reboot|shutdown|halt|poweroff|docker|kubectl|crontab)\b/i;
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
function resolveGuestCommandPath(raw: string, cwd: string, guestSkillDir?: string): string {
  if (guestSkillDir && (raw === '~' || raw.startsWith('~/'))) {
    const home = dirname(dirname(guestSkillDir));
    return raw === '~' ? home : resolve(home, raw.slice(2));
  }
  return raw.startsWith('~') ? expandHome(raw) : resolve(cwd, raw);
}

function isGuestSkillPath(candidate: string, guestSkillDir?: string): boolean {
  if (!guestSkillDir) return false;
  const skillRel = relative(guestSkillDir, candidate);
  return !skillRel.startsWith('..') && !isAbsolute(skillRel) && skillRel !== '';
}

export async function constrainGuestBash(command: string, cwd: string, workspaceRoot?: string, guestSkillDir?: string): Promise<{ error: string; command: string; cwd: string } | undefined> {
  if (!workspaceRoot) return undefined;
  try { await resolveInWorkspace(cwd, workspaceRoot); }
  catch { return { error: GUEST_DENIAL, command, cwd }; }

  if (SYSTEM_COMMAND.test(command) || /\bnohup\b[^\n]*&\s*(?:$|[;])/i.test(command)) {
    return { error: `${GUEST_DENIAL}：禁止系统级命令`, command, cwd };
  }
  if (containsSensitivePathReference(command)) {
    return { error: `${GUEST_DENIAL}：禁止读取管理员凭据文件`, command, cwd };
  }
  const touchesFilesystem = FILESYSTEM_COMMAND.test(command) || /[<>]/.test(command);
  const words = commandWords(command);
  const embeddedPaths = command.match(/(?:^|[\s'"=(])((?:~(?:\/|$)|\/)[^\s'";&|()<>]*)/g)?.map((match) => match.trim().replace(/^['"=(]+/, '')) ?? [];
  for (const rawWord of [...words, ...embeddedPaths]) {
    const word = rawWord.replace(/^["']|["',:]$/g, '');
    if (!word || word.startsWith('-')) continue;
    if (touchesFilesystem && (word.includes('$') || word.includes('`') || /[*?\[\]]/.test(word))) {
      return { error: `${GUEST_DENIAL}：无法安全解析路径`, command, cwd };
    }
    const explicitlyPathLike = word.startsWith('/') || word.startsWith('~') || word === '..' || word.startsWith('../');
    if (!touchesFilesystem && !explicitlyPathLike) continue;
    const candidate = resolveGuestCommandPath(word, cwd, guestSkillDir);
    try { assertGuestPathNotSensitive(candidate); }
    catch { return { error: `${GUEST_DENIAL}：禁止读取管理员凭据文件`, command, cwd }; }
    if (isGuestSkillPath(candidate, guestSkillDir)) continue;
    try { await resolveInWorkspace(candidate, workspaceRoot); }
    catch { return { error: `${GUEST_DENIAL}：路径越界`, command, cwd }; }
  }
  return undefined;
}

async function guestScriptContents(command: string, cwd: string, workspaceRoot: string, guestSkillDir?: string): Promise<string[]> {
  type PendingScript = { raw: string; referencedBy?: string };
  const pending: PendingScript[] = [];
  const patterns = [
    /(?:^|[;&|(\n]\s*)(?:bash|sh|source)[ \t]+(?:--[ \t]+)?(["']?)([^\s;&|()<>]+)\1/g,
    /(?:^|[;&|(\n]\s*)\.\s+(["']?)([^\s;&|()<>]+)\1/g,
    /(?:^|[;&|(\n]\s*)(\.\.?\/[^\s;&|()<>]+)/g,
  ];
  const enqueueScripts = (text: string, referencedBy?: string): void => {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) pending.push({ raw: match[2] ?? match[1], referencedBy });
    }
  };
  const substituteSkillInternalReferences = (raw: string, referencedBy: string): string => {
    const scriptDir = dirname(referencedBy);
    const bashSource = String.raw`(?:\$\{BASH_SOURCE\[0\]\}|\$BASH_SOURCE(?:\[0\])?)`;
    return raw
      .replace(new RegExp(String.raw`\$\(\s*cd\s+["']?\$\(\s*dirname\s+["']?${bashSource}["']?\s*\)["']?\s*&&\s*pwd\s*\)`, 'g'), () => scriptDir)
      .replace(new RegExp(String.raw`\$\(\s*dirname\s+["']?${bashSource}["']?\s*\)`, 'g'), () => scriptDir)
      .replace(new RegExp("`\\s*dirname\\s+[\"']?" + bashSource + "[\"']?\\s*`", 'g'), () => scriptDir)
      .replace(/\$(?:\{(?:SCRIPT_DIR|DIR|PWD)\}|(?:SCRIPT_DIR|DIR|PWD)\b)/g, () => scriptDir)
      .replace(new RegExp(bashSource, 'g'), () => referencedBy);
  };
  const resolveSkillInternalDynamicPath = (raw: string, referencedBy: string): string => {
    const scriptDir = dirname(referencedBy);
    const substituted = substituteSkillInternalReferences(raw, referencedBy);
    if (substituted.includes('$') || substituted.includes('`')) {
      throw new Error(`${GUEST_DENIAL}：无法安全解析脚本路径`);
    }
    const candidate = resolveGuestCommandPath(substituted, scriptDir, guestSkillDir);
    if (!isGuestSkillPath(candidate, guestSkillDir)) {
      throw new Error(`${GUEST_DENIAL}：路径越界（脚本内容）`);
    }
    return candidate;
  };
  enqueueScripts(command);
  const contents: string[] = [];
  const seen = new Set<string>();
  while (pending.length) {
    const { raw, referencedBy } = pending.shift()!;
    if (!raw || raw.startsWith('-')) {
      throw new Error(`${GUEST_DENIAL}：无法安全解析脚本路径`);
    }
    const dynamic = raw.includes('$') || raw.includes('`');
    if (dynamic && (!referencedBy || !isGuestSkillPath(referencedBy, guestSkillDir))) {
      throw new Error(`${GUEST_DENIAL}：无法安全解析脚本路径`);
    }
    const candidate = dynamic
      ? resolveSkillInternalDynamicPath(raw, referencedBy!)
      : resolveGuestCommandPath(raw, cwd, guestSkillDir);
    const path = isGuestSkillPath(candidate, guestSkillDir)
      ? candidate
      : await resolveInWorkspace(candidate, workspaceRoot);
    assertGuestPathNotSensitive(path);
    if (seen.has(path)) continue;
    seen.add(path);
    let content: string;
    try { content = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${GUEST_DENIAL}：找不到需要安全检查的脚本 ${raw}`);
      throw error;
    }
    if (content.length > 1024 * 1024) throw new Error(`${GUEST_DENIAL}：脚本过大，无法安全检查`);
    contents.push(isGuestSkillPath(path, guestSkillDir) ? substituteSkillInternalReferences(content, path) : content);
    enqueueScripts(content, path);
  }
  return contents;
}

/** 读取 cwd/.git/config 里 origin remote 的 owner（仓库属主）。无 .git 或无 remote 返回 undefined。 */
async function readGitConfig(cwd: string): Promise<{ remoteOwner?: string; remoteUrl: string } | undefined> {
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
  return { remoteUrl: url, ...(ownerMatch ? { remoteOwner: decodeURIComponent(ownerMatch[1]) } : {}) };
}

/**
 * Guest git 强制安全层：
 * 1. git commit 强制使用当前用户的 Gitea 身份（guestN），覆盖任何用户设的 user.name/user.email；
 * 2. git push/clone/fetch/pull 只允许访问当前用户自己的账号（guestN）或专属组织（guestN-org），
 *    其余 owner（admin、其他 guestN、陌生组织）一律拒绝 —— 防止用非本用户账号提交/部署；
 * 3. 远程操作的凭据由当前身份的 SQLite token 通过进程环境注入，不接受模型提供的身份或 token。
 * 返回 { command } 为改写后的安全命令，或 { error } 拒绝执行。
 */
async function enforceGuestGit(
  command: string,
  username: string,
  guestOsUser: string,
  cwd: string,
  lookupToken: (username: string) => Promise<string | undefined>,
  rewrite = true,
): Promise<{ command: string } | { error: string }> {
  if (!/\bgit\b/.test(command)) return { command };
  if (/\b(?:GIT_(?:ASKPASS|CONFIG[^=\s]*|CREDENTIAL[^=\s]*|SSH_COMMAND)|SSH_ASKPASS|HOME)\s*=/i.test(command)
      || /\bgit\b[^\n;&|]*(?:-c\s+(?:credential\.|http\.[^\s=]*extraheader|url\.)|--config-env=)/i.test(command)
      || /\bgit\s+(?:config\b[^\n;&|]*(?:user\.(?:name|email)|credential\.|url\.)|credential\b)/i.test(command)) {
    return { error: `${GUEST_DENIAL}：git 身份和凭据由当前登录用户上下文强制提供，不能自行修改` };
  }

  const guestOrg = `${guestOsUser}-org`;

  // 校验远程 URL 的 owner 必须是本用户（guestN 或 guestN-org）
  const validateRemote = (url: string): string | undefined => {
    if (/^https?:\/\/[^/@]+@/i.test(url)) return 'DENY:CREDENTIALS';
    const match = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!match) return undefined;
    const host = match[1];
    const owner = decodeURIComponent(match[2]);
    const repo = match[3];
    if (owner === guestOsUser || owner === guestOrg) {
      return `${url.startsWith('https:') ? 'https' : 'http'}://${host}/${owner}/${repo}.git`;
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
  const urlMatch = command.match(/\bgit\s+(?:push|clone|fetch|pull)\b[^|;&\n]*?(https?:\/\/[^\s|;&]+)/);
  const hasRemoteOperation = /\bgit\s+(?:push|clone|fetch|pull)\b/.test(command);
  const token = hasRemoteOperation ? await lookupToken(username) : undefined;
  if (hasRemoteOperation && !token) return { error: `${GUEST_DENIAL}：无法获取 ${username} 的 Gitea token，禁止 git 远程操作` };
  if (hasRemoteOperation) {
    if (urlMatch?.[1]) {
      const original = urlMatch[1].replace(/["']$/, '');
      const rewritten = validateRemote(original);
      if (!rewritten) return { error: `${GUEST_DENIAL}：无法解析远程仓库地址，禁止 git 远程操作` };
      if (rewritten === 'DENY:CREDENTIALS') return { error: `${GUEST_DENIAL}：远程地址不能携带账号或 token，凭据由当前登录用户上下文提供` };
      if (rewritten.startsWith('DENY:')) {
        return { error: `${GUEST_DENIAL}：git 远程仓库必须属于你本人（${guestOsUser} 或 ${guestOrg}），不能使用其他账号（${rewritten.slice(5)}）的仓库` };
      }
      return { command: rewrite ? command.replace(original, rewritten) : command };
    }
    // 无显式 URL：走默认 remote origin —— 校验 .git/config 里的 remote 必须指向本人仓库
    // 命令可能先 cd 到子目录（cd proj && git push），需用实际 git 目录读配置
    const cdMatch = command.match(/\bcd\s+([^\s;&|()]+)/);
    const gitDir = cdMatch ? resolve(cwd, cdMatch[1].replace(/^["']|["']$/g, '')) : cwd;
    const config = await readGitConfig(gitDir);
    if (!config) return { error: `${GUEST_DENIAL}：找不到可验证的 git remote，禁止远程操作` };
    if (/^https?:\/\/[^/@]+@/i.test(config.remoteUrl)) return { error: `${GUEST_DENIAL}：git remote 不能携带账号或 token，凭据由当前登录用户上下文提供` };
    const owner = config.remoteOwner;
    if (!owner) return { error: `${GUEST_DENIAL}：无法解析 git remote，禁止远程操作` };
    if (owner !== guestOsUser && owner !== guestOrg) {
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

async function enforceGuestCurl(
  command: string,
  username: string,
  guestOsUser: string,
  lookupToken: (username: string) => Promise<string | undefined>,
  giteaBaseUrl: string | undefined,
  rewrite = true,
): Promise<{ command: string } | { error: string }> {
  if (!/\bcurl\b/i.test(command)) return { command };
  let configuredBase: URL | undefined;
  try { if (giteaBaseUrl) configuredBase = new URL(giteaBaseUrl); } catch { /* invalid config fails closed for credential-bearing curl below */ }
  const urls = [...command.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((match) => match[0].replace(/[),;]+$/, ''));
  const giteaRequest = urls.some((value) => {
    try {
      const target = new URL(value);
      if (configuredBase && target.origin === configuredBase.origin) {
        const prefix = configuredBase.pathname.replace(/\/$/, '');
        return !prefix || prefix === '/' || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
      }
      return /^(?:127\.0\.0\.1|localhost)$/.test(target.hostname) && target.port === '3000';
    } catch { return false; }
  });
  const hasCredentials = /(?:authorization\s*:|private-token\s*:|access_token=|\bcurl\b[^\n;&|]*\s-u\s+|https?:\/\/[^/@\s]+@)/i.test(command);
  if (!giteaRequest) return hasCredentials
    ? { error: `${GUEST_DENIAL}：不能向非 Gitea 地址发送模型提供的账号或 token` }
    : { command };
  const owners = [...command.matchAll(/\/api\/v1\/(?:repos\/|orgs\/)([^/\s"']+)/gi)].map((match) => decodeURIComponent(match[1]));
  const guestOrg = `${guestOsUser}-org`;
  const foreign = owners.find((owner) => owner !== guestOsUser && owner !== guestOrg);
  if (foreign) return { error: `${GUEST_DENIAL}：Gitea 操作必须属于你本人（${guestOsUser} 或 ${guestOrg}），不能使用其他账号（${foreign}）` };
  if (!rewrite) return { error: `${GUEST_DENIAL}：脚本中的 Gitea API 调用无法验证身份；请直接调用，由工具注入当前用户身份` };
  const token = await lookupToken(username);
  if (!token) return { error: `${GUEST_DENIAL}：无法获取 ${username} 的 Gitea token，禁止 Gitea API 操作` };
  let out = command
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s"']+/gi, `$1${token}`)
    .replace(/(access_token=)[^&\s"']+/gi, `$1${token}`)
    .replace(/(\bcurl\b[^\n;&|]*?\s-u\s+)(?:[^\s:"']+):[^\s"']+/gi, `$1${guestOsUser}:${token}`);
  if (!hasCredentials) out = out.replace(/\bcurl\b/i, `curl -H 'Authorization: token ${token}'`);
  return { command: out };
}

function guestHome(workspaceRoot: string, guestOsUser: string): string {
  const parent = dirname(workspaceRoot);
  return workspaceRoot.endsWith(`/${guestOsUser}/projects`) ? parent : `/home/${guestOsUser}`;
}

function guestEnvironment(guestOsUser: string, home: string, token: string | undefined): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: home, USER: guestOsUser, LOGNAME: guestOsUser, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: guestOsUser,
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: `${guestOsUser}@taiwei.local`,
    GIT_CONFIG_KEY_2: 'credential.helper',
    GIT_CONFIG_VALUE_2: token ? `!f() { echo username=${guestOsUser}; echo password=$TAIWEI_GITEA_TOKEN; }; f` : '',
    ...(token ? { TAIWEI_GITEA_TOKEN: token } : {}),
  };
}

export function createBashTool(dependencies: BashToolDependencies = {}): ToolSpec {
  const executeFile = dependencies.executeFile ?? execFileAsync as BashExecutor;
  const lookupOsUser = dependencies.lookupOsUser ?? osUserForGuest;
  const lookupGiteaToken = dependencies.lookupGiteaToken ?? giteaTokenFor;
  const lookupGiteaBaseUrl = dependencies.lookupGiteaBaseUrl ?? (async () => (await loadConfig()).gitea.baseUrl);
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
        if (!context.identity) return { error: `${GUEST_DENIAL}：缺少已认证用户身份，禁止执行命令`, command, cwd };
        let guestOsUser: string | undefined;
        if (context.tenantIdentity !== undefined) {
          guestOsUser = context.tenantIdentity.osUsername?.trim() || undefined;
          if (!guestOsUser) return { error: `${GUEST_DENIAL}：无法解析当前用户的系统账号，禁止执行命令`, command, cwd };
        } else {
          try { guestOsUser = await lookupOsUser(context.identity); }
          catch (error) {
            warn(`[taiwei] OS account lookup failed for guest ${context.identity}: ${error instanceof Error ? error.message : String(error)}`);
            return { error: `${GUEST_DENIAL}：无法解析当前用户的系统账号，禁止执行命令`, command, cwd };
          }
        }
        if (!guestOsUser) return { error: `${GUEST_DENIAL}：当前用户没有可用的系统账号，禁止执行命令`, command, cwd };
        const guestSkillDir = resolve(guestHome(context.workspaceRoot ?? cwd, guestOsUser), '.taiwei', 'skills');
        if (context.workspaceRoot) {
          const denial = await constrainGuestBash(command, cwd, context.workspaceRoot, guestSkillDir);
          if (denial) return denial;
        }
        if (!isRoot()) return { error: `${GUEST_DENIAL}：网关无法切换到 ${guestOsUser}，禁止以网关账号执行 guest 命令`, command, cwd };
        const giteaIdentity = context.tenantIdentity !== undefined
          ? context.tenantIdentity.giteaUsername?.trim()
          : context.identity;
        const lookupSessionGiteaToken = async (_username: string): Promise<string | undefined> => (
          giteaIdentity ? lookupGiteaToken(giteaIdentity) : undefined
        );
        let giteaBaseUrl: string | undefined;
        try { giteaBaseUrl = await lookupGiteaBaseUrl(); }
        catch { giteaBaseUrl = undefined; }
        const scripts = context.workspaceRoot ? await guestScriptContents(command, cwd, context.workspaceRoot, guestSkillDir) : [];
        for (const script of scripts) {
          const normalizedScript = script.replace(/\\\r?\n/g, '');
          const scriptGit = await enforceGuestGit(normalizedScript, giteaIdentity ?? context.identity, guestOsUser, cwd, lookupSessionGiteaToken, false);
          if ('error' in scriptGit) return { error: scriptGit.error, command, cwd };
          const scriptCurl = await enforceGuestCurl(normalizedScript, giteaIdentity ?? context.identity, guestOsUser, lookupSessionGiteaToken, giteaBaseUrl, false);
          if ('error' in scriptCurl) return { error: scriptCurl.error, command, cwd };
          for (const line of script.split('\n')) {
            if (!line.trim() || line.startsWith('#!')) continue;
            const denial = await constrainGuestBash(line, cwd, context.workspaceRoot, guestSkillDir);
            if (denial) return { ...denial, error: `${denial.error}（脚本内容）` };
            const git = await enforceGuestGit(line, giteaIdentity ?? context.identity, guestOsUser, cwd, lookupSessionGiteaToken, false);
            if ('error' in git) return { error: git.error, command, cwd };
            const curl = await enforceGuestCurl(line, giteaIdentity ?? context.identity, guestOsUser, lookupSessionGiteaToken, giteaBaseUrl, false);
            if ('error' in curl) return { error: curl.error, command, cwd };
          }
        }
        const git = await enforceGuestGit(command, giteaIdentity ?? context.identity, guestOsUser, cwd, lookupSessionGiteaToken);
        if ('error' in git) return { error: git.error, command, cwd };
        command = git.command;
        const curl = await enforceGuestCurl(command, giteaIdentity ?? context.identity, guestOsUser, lookupSessionGiteaToken, giteaBaseUrl);
        if ('error' in curl) return { error: curl.error, command, cwd };
        command = curl.command;
        if (context.authorizeCommand && !await context.authorizeCommand(command, cwd)) {
          return { error: '用户拒绝了该命令的执行', command, cwd };
        }
        const token = /\b(?:git\s+(?:push|clone|fetch|pull)|curl\b)/i.test(`${command}\n${scripts.join('\n')}`)
          ? await lookupSessionGiteaToken(giteaIdentity ?? context.identity)
          : undefined;
        const result = await executeFile('runuser', ['-u', guestOsUser, '--preserve-environment', '--', '/bin/bash', '-lc', command], {
          cwd, signal: context.signal, timeout: Number(args.timeout_ms ?? 120_000), maxBuffer: 10 * 1024 * 1024,
          env: guestEnvironment(guestOsUser, guestHome(context.workspaceRoot ?? cwd, guestOsUser), token),
        });
        return { stdout: redactCredentialText(result.stdout), stderr: redactCredentialText(result.stderr) };
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
