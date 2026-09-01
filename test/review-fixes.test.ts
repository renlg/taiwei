import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type TaiweiConfig } from '../src/config/config.js';
import type { ChatBridge, ChatSink } from '../src/gateway/chat.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import { PolicyEngine } from '../src/security/policy.js';
import { createBashTool } from '../src/tools/impl/bash.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { installGatewayTestAdminAuth } from './gateway-test-auth.js';

installGatewayTestAdminAuth();

/** 可手动放行的 chat 桥：run 挂起直到 release()/stop()；stop 只在有活跃回合时生效。 */
class GatedChat implements ChatBridge {
  stoppedCount = 0;
  activeRuns = 0;
  private resolveRun: (() => void) | undefined;

  async run(_message: string, sink: ChatSink): Promise<void> {
    this.activeRuns += 1;
    try {
      sink.event({ type: 'token', text: 'partial ' });
      await new Promise<void>((resolve) => { this.resolveRun = resolve; });
      sink.event({ type: 'token', text: 'answer' });
      sink.event({ type: 'done', text: 'partial answer' });
    } finally {
      this.activeRuns -= 1;
    }
  }

  release(): void { this.resolveRun?.(); }
  stop(): boolean {
    if (this.activeRuns <= 0) return false;
    this.stoppedCount += 1;
    this.resolveRun?.();
    return true;
  }
}

async function readSse(response: Response): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let stream = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stream += decoder.decode(value, { stream: true });
  }
  return stream;
}

test('guest bash cannot exfiltrate the injected Gitea token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-guest-token-'));
  const executions: Array<{ env: NodeJS.ProcessEnv | undefined }> = [];
  try {
    const guestOsUser = 'guest1';
    const guestHomeDir = join(directory, guestOsUser);
    const workspace = join(guestHomeDir, 'projects');
    const skillDir = join(guestHomeDir, '.taiwei', 'skills', 'leak');
    await mkdir(workspace, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    const registry = new ToolRegistry();
    registry.register(createBashTool({
      lookupOsUser: async () => guestOsUser,
      lookupGiteaToken: async () => 'gitea-secret-token',
      lookupGiteaBaseUrl: async () => 'https://gitea.example.com',
      isRoot: () => true,
      executeFile: async (_file, _args, options) => {
        executions.push({ env: options?.env });
        return { stdout: '', stderr: '' };
      },
    }));
    const policy = new PolicyEngine({ rules: [{ match: { role: 'guest', tool: 'bash' }, effect: 'allow' }] });
    const run = (command: string) => registry.dispatch('bash', { command }, {
      cwd: workspace, workspaceRoot: workspace, role: 'guest', identity: 'alice', policy,
    });

    // 直接引用注入的凭据环境变量名 → 拒绝
    assert.match(await run('echo $TAIWEI_GITEA_TOKEN'), /命令不能引用 TAIWEI_GITEA_TOKEN/);

    // 脚本中间接引用 → 拒绝
    await writeFile(join(skillDir, 'leak.sh'), '#!/bin/bash\necho "$TAIWEI_GITEA_TOKEN"\n');
    assert.match(await run(`bash ${join(skillDir, 'leak.sh')}`), /命令不能引用 TAIWEI_GITEA_TOKEN/);

    // 注入凭据（git 远程操作）时禁止转储环境变量
    assert.match(await run('git push https://gitea.example.com/guest1/repo.git && printenv'), /禁止导出或打印环境变量/);

    // 脚本内转储环境变量同样被拦截（凭据因 git push 被注入到 combinedCommand）
    await writeFile(join(skillDir, 'dump.sh'), '#!/bin/bash\nprintenv\n');
    assert.match(
      await run(`bash ${join(skillDir, 'dump.sh')} && git push https://gitea.example.com/guest1/repo.git`),
      /禁止导出或打印环境变量/,
    );

    // 非远程 git 命令不再向环境注入 token
    assert.equal(JSON.parse(await run('echo hello') as string).error, undefined);
    assert.equal(executions.at(-1)?.env?.TAIWEI_GITEA_TOKEN, undefined, '普通命令不应注入 Gitea token');

    // 合法 git 远程操作仍注入 token（供 credential helper 使用）
    assert.equal(JSON.parse(await run('git push https://gitea.example.com/guest1/repo.git') as string).error, undefined);
    assert.equal(executions.at(-1)?.env?.TAIWEI_GITEA_TOKEN, 'gitea-secret-token', 'git 远程操作应注入 Gitea token');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('environment overrides stay runtime-only and are not persisted by saveConfig', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-config-env-'));
  const previousHome = process.env.TAIWEI_HOME;
  const previousApiKey = process.env.TAIWEI_API_KEY;
  const previousAuthPassword = process.env.TAIWEI_AUTH_PASSWORD;
  process.env.TAIWEI_HOME = directory;
  process.env.TAIWEI_API_KEY = 'env-secret-api-key';
  process.env.TAIWEI_AUTH_PASSWORD = 'env-secret-password';
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ apiKey: 'disk-api-key' }));
    const config = await loadConfig();
    assert.equal(config.apiKey, 'env-secret-api-key');
    assert.equal(config.auth.password, 'env-secret-password');

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as {
      apiKey?: string; auth?: { password?: string }; providers?: Array<{ id?: string; apiKey?: string }>;
    };
    assert.equal(persisted.apiKey, 'disk-api-key', 'env 覆盖值应恢复为磁盘原值');
    assert.notEqual(persisted.auth?.password, 'env-secret-password');
    const persistedProvider = persisted.providers?.find((provider) => provider?.id === 'default');
    assert.notEqual(persistedProvider?.apiKey, 'env-secret-api-key');
    assert.ok(!JSON.stringify(persisted).includes('env-secret-api-key'), 'env 密钥不应写入 config.json');
    assert.ok(!JSON.stringify(persisted).includes('env-secret-password'), 'env 密码不应写入 config.json');

    // 用户刻意修改的值即使存在同名 env 覆盖也会保留
    config.apiKey = 'user-chosen-key';
    await saveConfig(config);
    const repersisted = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { apiKey?: string };
    assert.equal(repersisted.apiKey, 'user-chosen-key');
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    if (previousApiKey === undefined) delete process.env.TAIWEI_API_KEY; else process.env.TAIWEI_API_KEY = previousApiKey;
    if (previousAuthPassword === undefined) delete process.env.TAIWEI_AUTH_PASSWORD; else process.env.TAIWEI_AUTH_PASSWORD = previousAuthPassword;
    await rm(directory, { recursive: true, force: true });
  }
});

test('oauth state registration is capped against unauthenticated memory abuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-oauth-cap-'));
  const config = structuredClone(DEFAULT_CONFIG) as TaiweiConfig;
  config.oauth.enabled = true;
  config.oauth.providerBaseUrl = 'https://sso.example.com';
  const server = createGatewayServer({
    chat: { run: async () => {}, stop: () => false },
    sessions: new SessionStore(join(directory, 'sessions')),
    history: false,
    uploadsDirectory: join(directory, 'uploads'),
    configState: { load: async () => structuredClone(config), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const start = (state: string) => fetch(`${baseUrl}/api/oauth/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }),
  });
  try {
    const state = (index: number) => index.toString(16).padStart(32, '0');
    for (let batch = 0; batch < 20; batch++) {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => start(state(batch * 50 + index))),
      );
      for (const response of responses) assert.equal(response.status, 200);
    }
    const overflow = await start(state(1000));
    assert.equal(overflow.status, 429, '超过上限后应拒绝新的 OAuth state 注册');
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('stop without an active turn does not kill the next turn after disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-stop-stale-'));
  const chat = new GatedChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  const server = createGatewayServer({
    chat, sessions, history: false,
    uploadsDirectory: join(directory, 'uploads'),
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };

    // 无进行中 turn 时的 stop：不应记录陈旧停止意图
    const idleStop = await (await fetch(`${baseUrl}/api/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: created.id }),
    })).json() as { stopped: boolean };
    assert.equal(idleStop.stopped, false);

    // 新回合进行中客户端断开：应继续后台执行而非误停
    const controller = new AbortController();
    const chatPromise = fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: created.id }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await chatPromise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(chat.stoppedCount, 0, '断开连接不应停止未被显式停止的回合');

    // 收尾：放行后台回合，让路由正常终结（清理 pending 定时器/状态）
    chat.release();
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('stop applies to the running turn only; the next turn completes normally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-stop-next-turn-'));
  const chat = new GatedChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  const server = createGatewayServer({
    chat, sessions, history: false,
    uploadsDirectory: join(directory, 'uploads'),
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };

    // 回合 1：显式停止
    const first = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'one', sessionId: created.id }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopResponse = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: created.id }),
    });
    assert.equal((await stopResponse.json() as { stopped: boolean }).stopped, true);
    assert.equal(chat.stoppedCount, 1);
    const firstStream = await readSse(first);
    assert.match(firstStream, /event: done/);

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 回合 2：不受上一回合停止意图影响，正常完成
    const second = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'two', sessionId: created.id }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    chat.release();
    const secondStream = await readSse(second);
    assert.match(secondStream, /event: done\ndata: \{"text":"partial answer"/);
    assert.equal(chat.stoppedCount, 1, '新回合不应被上一回合的停止意图误停');
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});
