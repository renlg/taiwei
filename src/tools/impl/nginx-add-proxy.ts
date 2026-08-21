import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { appendAudit } from '../../observability/audit.js';
import { getPaths } from '../../util/paths.js';
import type { ToolContext, ToolSpec } from '../registry.js';

const SCRIPT_PATH = '/root/.taiwei/skills/taiwei-编程部署/scripts/nginx_deploy.py';
const LOCATIONS_PATH = '/etc/nginx/taiwei-projects-locations.conf';
const RESERVED_PORTS = new Set([8688, 8890, 8899]);
const PROXY_PATH = /^\/taiwei\/([0-9a-f]{8})\/([a-z0-9][a-z0-9-]*)\/$/;

export interface NginxExecutorResult { stdout: string; stderr: string; exitCode: number; }

export interface NginxAddProxyDependencies {
  probeService?: (host: string, port: number, signal?: AbortSignal) => Promise<boolean>;
  probePublicIp?: () => Promise<string | undefined>;
  readLocations?: () => Promise<string>;
  execute?: (file: string, args: string[], options: { shell: false; signal?: AbortSignal }) => Promise<NginxExecutorResult>;
  serverIp?: () => string | undefined;
  publicUrl?: string;
  now?: () => Date;
  audit?: typeof appendAudit;
}

function defaultProbeService(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    if (signal) {
      if (signal.aborted) finish(false);
      else signal.addEventListener('abort', () => finish(false), { once: true });
    }
  });
}

async function defaultReadLocations(): Promise<string> {
  try { return await readFile(LOCATIONS_PATH, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function defaultExecute(file: string, args: string[], options: { shell: false; signal?: AbortSignal }): Promise<NginxExecutorResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError: Error | undefined;
    child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code) => resolve({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: `${Buffer.concat(stderr).toString('utf8')}${spawnError ? `${stderr.length ? '\n' : ''}${spawnError.message}` : ''}`,
      exitCode: code ?? -1,
    }));
  });
}

function defaultServerIp(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

async function defaultProbePublicIp(): Promise<string | undefined> {
  try {
    const response = await globalThis.fetch('https://api.ipify.org', { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    return (await response.text()).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseInternalAddr(value: unknown): { host: string; port: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([^:\s]+):(\d+)$/.exec(value);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || RESERVED_PORTS.has(port)) return undefined;
  return { host: match[1]!, port };
}

function usageError(): { error: string } {
  return { error: '参数错误。正确用法: internalAddr 必须是 host:port（端口 1-65535，且不能使用 8688/8890/8899）；path 必须是 /taiwei/<8位小写十六进制ownerHash>/<小写字母数字或连字符name>/' };
}

function errorSummary(stderr: string, exitCode: number): string {
  const normalized = stderr.trim();
  return normalized ? normalized.slice(-1_000) : `脚本退出码 ${exitCode}`;
}

export function createNginxAddProxyTool(dependencies: NginxAddProxyDependencies = {}): ToolSpec {
  const probeService = dependencies.probeService ?? defaultProbeService;
  const readLocations = dependencies.readLocations ?? defaultReadLocations;
  const execute = dependencies.execute ?? defaultExecute;
  const serverIp = dependencies.serverIp ?? defaultServerIp;
  const probePublicIp = dependencies.probePublicIp ?? defaultProbePublicIp;
  const configuredPublicUrl = (dependencies.publicUrl ?? '').trim();
  const now = dependencies.now ?? (() => new Date());
  const audit = dependencies.audit ?? appendAudit;

  return {
    name: 'nginx_add_proxy',
    description: '为已启动的项目配置 nginx 反向代理。**仅项目第一次启动时执行此工具**;之后重新部署项目不需要再执行,反代会保留。执行前自动校验:①目标内网服务是否可访问 ②是否已有该反代配置(已有则幂等返回)。admin 和 guest 均可运行。',
    parameters: {
      type: 'object',
      properties: {
        internalAddr: { type: 'string', description: '项目内网地址，格式 host:port，例如 127.0.0.1:8085。' },
        path: { type: 'string', description: '反代路径，格式 /taiwei/<ownerHash>/<name>/。' },
      },
      required: ['internalAddr', 'path'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const internalAddr = args.internalAddr;
      const path = typeof args.path === 'string' ? args.path : undefined;
      const parsedAddr = parseInternalAddr(internalAddr);
      const parsedPath = path ? PROXY_PATH.exec(path) : null;
      const actor = context.identity ?? context.role ?? 'admin';
      const role = context.role ?? 'admin';
      const auditBase = {
        type: 'nginx.add-proxy', runId: context.runId ?? 'nginx-add-proxy', sessionId: context.sessionId ?? 'nginx-add-proxy',
        actor, role, internalAddr, path,
      };
      const finish = async <T extends Record<string, unknown>>(result: T, details: Record<string, unknown> = {}): Promise<T> => {
        const ok = result.ok === true;
        await audit({ ...auditBase, outcome: ok ? 'success' : 'error', ...details, ...result, ok }).catch(() => {});
        return result;
      };
      if (!parsedAddr || !parsedPath || !path) return finish(usageError());

      const ownerHash = parsedPath[1]!;
      const name = parsedPath[2]!;
      const { host, port } = parsedAddr;
      const details = { ownerHash, name, port };
      if (!await probeService(host, port, context.signal)) {
        return finish({ error: `服务不存在或未启动: ${internalAddr},请先启动项目再执行` }, details);
      }

      const locations = await readLocations();
      let url: string;
      if (configuredPublicUrl) {
        url = configuredPublicUrl.replace(/\/+$/, '') + path;
      } else {
        const probed = await probePublicIp();
        const externalIp = probed || serverIp();
        url = externalIp ? `http://${externalIp}${path}` : path;
      }
      if (locations.includes(`location ${path} {`)) {
        return finish({ ok: true, message: `反代已存在: ${path},无需重复配置`, alreadyExists: true, url }, details);
      }

      const result = await execute('python3', [SCRIPT_PATH, ownerHash, name, String(port)], { shell: false, signal: context.signal });
      const timestamp = now();
      const logDirectory = join(getPaths().home, 'logs');
      const logPath = join(logDirectory, `nginx-add-${timestamp.toISOString().replace(/[:.]/g, '-')}.log`);
      await mkdir(logDirectory, { recursive: true });
      await writeFile(logPath, [
        `time: ${timestamp.toISOString()}`,
        `caller: ${actor}`,
        `role: ${role}`,
        `internalAddr: ${internalAddr}`,
        `path: ${path}`,
        `ownerHash: ${ownerHash}`,
        `name: ${name}`,
        `port: ${port}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
        `exitCode: ${result.exitCode}`,
        '',
      ].join('\n'), 'utf8');

      if (result.exitCode === 0) return finish({ ok: true, message: '反代已配置成功', url, logPath }, details);
      return finish({ ok: false, error: `nginx 配置失败: ${errorSummary(result.stderr, result.exitCode)}`, logPath }, details);
    },
  };
}

export const nginxAddProxyTool = createNginxAddProxyTool();
