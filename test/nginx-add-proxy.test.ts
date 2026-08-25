import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createNginxAddProxyTool, expectedOwnerHash, type NginxAddProxyDependencies } from '../src/tools/impl/nginx-add-proxy.js';
import { PolicyEngine } from '../src/security/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';

const validArgs = { internalAddr: '127.0.0.1:8085', path: '/taiwei/8c6976e5/weather-app/' };
const context = { cwd: process.cwd(), role: 'admin' as const, identity: 'admin', runId: 'run-1', sessionId: 'session-1' };
const guestContext = { ...context, role: 'guest' as const, identity: 'guest1' };
const noAudit = async () => {};
const location = (path: string, port: number, host = '127.0.0.1') => [
  `location ${path} {`,
  `  proxy_pass http://${host}:${port}/;`,
  '}',
].join('\n');

function createTool(overrides: NginxAddProxyDependencies = {}) {
  return createNginxAddProxyTool({
    probeService: async () => true,
    probeHealth: async () => ({ ok: true }),
    readLocations: async () => '',
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    probePublicIp: async () => '203.0.113.10',
    serverIp: () => '203.0.113.10',
    audit: noAudit,
    ...overrides,
  });
}

test('nginx_add_proxy validates internalAddr, path, and reserved ports', async () => {
  const tool = createTool();
  for (const args of [
    { ...validArgs, internalAddr: '127.0.0.1' },
    { ...validArgs, internalAddr: '127.0.0.1:8890' },
    { ...validArgs, path: '/taiwei/not-a-hash/weather-app/' },
    { internalAddr: validArgs.internalAddr },
  ]) {
    const result = await tool.execute(args, context) as { error?: string };
    assert.match(result.error ?? '', /参数错误.*正确用法/);
  }
});

test('nginx_add_proxy stops when the internal service is unavailable', async () => {
  let executions = 0;
  const tool = createTool({
    probeService: async () => false,
    execute: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  const result = await tool.execute(validArgs, context) as { error?: string };
  assert.equal(result.error, '服务不存在或未启动: 127.0.0.1:8085,请先启动项目再执行');
  assert.equal(executions, 0);
});

test('nginx_add_proxy returns idempotently when the exact location exists', async () => {
  let executions = 0;
  const tool = createTool({
    readLocations: async () => location(validArgs.path, 8085),
    execute: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  const result = await tool.execute(validArgs, context) as { ok?: boolean; alreadyExists?: boolean; url?: string };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.url, 'http://203.0.113.10/taiwei/8c6976e5/weather-app/');
  assert.equal(executions, 0);
});

test('nginx_add_proxy rejects an existing path that points to a different port', async () => {
  let executions = 0;
  const tool = createTool({
    readLocations: async () => location(validArgs.path, 8084),
    execute: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  const result = await tool.execute(validArgs, context) as { error?: string };
  assert.match(result.error ?? '', /该 path 已存在且指向端口 8084，与请求端口 8085 不一致.*--remove.*--force/);
  assert.equal(executions, 0);
});

test('nginx_add_proxy rejects another path using the same host and port', async () => {
  const otherPath = '/taiwei/8c6976e5/quiz-system/';
  const tool = createTool({ readLocations: async () => location(otherPath, 8085) });
  const result = await tool.execute(validArgs, context) as { error?: string };
  assert.match(result.error ?? '', /端口 127\.0\.0\.1:8085 已被其他项目路由.*quiz-system.*占用/);
});

test('nginx_add_proxy rejects a guest using another identity ownerHash', async () => {
  const tool = createTool();
  const result = await tool.execute(validArgs, guestContext) as { error?: string };
  assert.match(result.error ?? '', /ownerHash 不匹配：path 里的 8c6976e5 与你的身份 4676424d 不符/);
});

test('nginx_add_proxy allows a guest using their own ownerHash', async () => {
  const guestArgs = { ...validArgs, path: '/taiwei/4676424d/weather-app/' };
  const tool = createTool({ readLocations: async () => location(guestArgs.path, 8085) });
  const result = await tool.execute(guestArgs, guestContext) as { ok?: boolean; alreadyExists?: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
});

test('nginx_add_proxy allows an admin to use any valid ownerHash', async () => {
  const arbitraryArgs = { ...validArgs, path: '/taiwei/a1b2c3d4/weather-app/' };
  const tool = createTool({ readLocations: async () => location(arbitraryArgs.path, 8085) });
  const result = await tool.execute(arbitraryArgs, context) as { ok?: boolean; alreadyExists?: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
});

test('expectedOwnerHash prefers the tenant OS username', () => {
  assert.equal(expectedOwnerHash({ ...guestContext, identity: 'oauth-user', tenantIdentity: { osUsername: 'guest1' } }), '4676424d');
});

test('nginx_add_proxy rejects a health identity that differs from the path name', async () => {
  const tool = createTool({ probeHealth: async () => ({ ok: true, name: 'quiz-system' }) });
  const result = await tool.execute(validArgs, context) as { error?: string };
  assert.equal(result.error, '该端口上的服务是 quiz-system，不是 weather-app，端口疑似被其他项目占用');
});

test('nginx_add_proxy accepts a healthy service without a name for compatibility', async () => {
  const tool = createTool({
    probeHealth: async () => ({ ok: true }),
    readLocations: async () => location(validArgs.path, 8085),
  });
  const result = await tool.execute(validArgs, context) as { ok?: boolean; alreadyExists?: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
});

test('nginx_add_proxy prefers configured publicUrl for an existing proxy', async () => {
  const tool = createTool({
    publicUrl: 'http://203.0.113.7/',
    probePublicIp: async () => { throw new Error('public IP probe should not run'); },
    readLocations: async () => location(validArgs.path, 8085),
  });
  const result = await tool.execute(validArgs, context) as { ok?: boolean; alreadyExists?: boolean; url?: string };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.url, 'http://203.0.113.7/taiwei/8c6976e5/weather-app/');
});

test('nginx_add_proxy uses the probed public IP for an existing proxy', async () => {
  const tool = createTool({
    probePublicIp: async () => '203.0.113.7',
    readLocations: async () => location(validArgs.path, 8085),
  });
  const result = await tool.execute(validArgs, context) as { ok?: boolean; alreadyExists?: boolean; url?: string };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.url, 'http://203.0.113.7/taiwei/8c6976e5/weather-app/');
});

test('nginx_add_proxy falls back to the server IP when public IP probing fails', async () => {
  const tool = createTool({
    probePublicIp: async () => undefined,
    serverIp: () => '203.0.113.11',
    readLocations: async () => location(validArgs.path, 8085),
  });
  const result = await tool.execute(validArgs, context) as { ok?: boolean; alreadyExists?: boolean; url?: string };
  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.url, 'http://203.0.113.11/taiwei/8c6976e5/weather-app/');
});

test('nginx_add_proxy invokes the fixed script with validated positional arguments and shell disabled', async () => {
  let invocation: { file: string; args: string[]; options: { shell: false } } | undefined;
  const tool = createTool({
    execute: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: 'done', stderr: 'reloaded', exitCode: 0 };
    },
  });
  const temporaryHome = await mkdtemp(join(tmpdir(), 'taiwei-nginx-invoke-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = temporaryHome;
  try {
    const result = await tool.execute(validArgs, context) as { ok?: boolean; url?: string };
    assert.equal(result.ok, true);
    assert.equal(result.url, 'http://203.0.113.10/taiwei/8c6976e5/weather-app/');
    assert.equal(invocation?.file, 'python3');
    assert.deepEqual(invocation?.args, [
      join(temporaryHome, 'skills', 'taiwei-编程部署', 'scripts', 'nginx_deploy.py'), '8c6976e5', 'weather-app', '8085',
    ]);
    assert.equal(invocation?.options.shell, false);
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test('guest policy allows nginx_add_proxy and bypasses URL-as-file boundary handling', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'taiwei-nginx-guest-'));
  const temporaryHome = await mkdtemp(join(tmpdir(), 'taiwei-nginx-home-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = temporaryHome;
  try {
    const registry = new ToolRegistry();
    registry.register(createTool());
    const guestArgs = { ...validArgs, path: '/taiwei/4676424d/weather-app/' };
    const decision = new PolicyEngine().decide({
      role: 'guest', agentMode: 'build', sessionId: 'guest-session', tool: 'nginx_add_proxy', args: guestArgs,
      cwd: workspace, workspaceRoot: workspace, identity: 'guest1',
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.allowExternalPath, true);
    const result = JSON.parse(await registry.dispatch('nginx_add_proxy', guestArgs, {
      cwd: workspace, workspaceRoot: workspace, role: 'guest', identity: 'guest1', sessionId: 'guest-session',
    })) as { ok?: boolean; error?: string };
    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(workspace, { recursive: true, force: true });
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test('nginx_add_proxy writes complete stdout, stderr, and exit code to its detail log', async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), 'taiwei-nginx-log-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = temporaryHome;
  try {
    const tool = createTool({
      now: () => new Date('2026-08-21T12:34:56.789Z'),
      execute: async () => ({ stdout: 'stdout line\n', stderr: 'stderr line\n', exitCode: 7 }),
    });
    const result = await tool.execute(validArgs, context) as { ok?: boolean; error?: string; logPath?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /nginx 配置失败: stderr line/);
    assert.equal(result.logPath, join(temporaryHome, 'logs', 'nginx-add-2026-08-21T12-34-56-789Z.log'));
    const log = await readFile(result.logPath!, 'utf8');
    assert.match(log, /caller: admin/);
    assert.match(log, /stdout:\nstdout line/);
    assert.match(log, /stderr:\nstderr line/);
    assert.match(log, /exitCode: 7/);
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
