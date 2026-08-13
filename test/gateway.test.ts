import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../src/agent/loop.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { AgentChatBridge, type ChatBridge, type ChatSink } from '../src/gateway/chat.js';
import { LOGIN_COOLDOWN_MS, LoginLockStore } from '../src/gateway/login-locks.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import type { ChatMessage } from '../src/llm/client.js';
import type { GatewayModelState } from '../src/gateway/server.js';
import { DEFAULT_CONFIG, type TaiweiConfig } from '../src/config/config.js';
import { hashPassword, isScryptPassword } from '../src/config/password.js';
import { HookRunner } from '../src/hooks/runner.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentContext } from '../src/agent/context.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import type { TaiweiApp } from '../src/app.js';

class MockChat implements ChatBridge {
  stopped = false;
  histories: ChatMessage[][] = [];
  messages: string[] = [];

  async run(message: string, sink: ChatSink, history: ChatMessage[] = []): Promise<void> {
    this.messages.push(message);
    this.histories.push(history);
    for (const event of [
      { type: 'token', text: 'Hello ' },
      { type: 'tool', name: 'read', args: { path: 'README.md' } },
      { type: 'tool_result', name: 'read', result: 'contents' },
      { type: 'token', text: 'world' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, contextWindow: 1_000 }, model: 'free' },
      { type: 'done', text: 'Hello world' },
    ] satisfies AgentEvent[]) sink.event(event);
  }

  stop(): boolean { this.stopped = true; return true; }
}

class ConfirmingChat implements ChatBridge {
  async run(_message: string, sink: ChatSink): Promise<void> {
    if (!sink.confirm) throw new Error('Confirmation sink is unavailable');
    const decision = await sink.confirm({
      id: 'confirmation-1', command: 'shutdown -h now', reason: 'system power command',
      pattern: '\\bshutdown\\b', level: 'danger', workspace: '/tmp/workspace', timeoutSeconds: 5,
    });
    sink.event({ type: 'done', text: decision.approve ? 'approved' : 'rejected' });
  }

  stop(): boolean { return true; }
}

class MockMcpBridge {
  reloads = 0;
  async reload(): Promise<void> { this.reloads += 1; }
  list(): Array<{ name: string; connected: boolean; detail: string }> {
    return [{ name: 'alpha', connected: true, detail: '2 tools' }];
  }
  async test(): Promise<{ connected: boolean; detail: string }> { return { connected: true, detail: '2 tools' }; }
}

test('gateway chat auto-loads only enabled skills by default and honors autoLoadSkills=false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-auto-skills-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  await mkdir(join(directory, 'skills', 'enabled'), { recursive: true });
  await mkdir(join(directory, 'skills', 'disabled'), { recursive: true });
  await writeFile(join(directory, 'skills', 'enabled', 'SKILL.md'), '---\nname: enabled\ndescription: Enabled skill\n---\n\nEnabled');
  await writeFile(join(directory, 'skills', 'disabled', 'SKILL.md'), '---\nname: disabled\ndescription: Disabled skill\n---\n\nDisabled');
  try {
    const skills = new SkillLoader(['disabled']);
    const memory = new MemoryStore();
    let capturedSkills: string[] = [];
    const makeApp = (autoLoadSkills: boolean) => ({
      config: { ...structuredClone(DEFAULT_CONFIG), autoLoadSkills },
      memory,
      skills,
      context: new AgentContext(memory, skills),
      run: async (_message: string, options: { context?: AgentContext }) => {
        capturedSkills = options.context?.listActiveSkills().map((skill) => skill.name) ?? [];
        return 'done';
      },
      interrupt: { cancel: () => false },
    }) as unknown as TaiweiApp;
    const sink: ChatSink = { event: () => {}, error: (error) => { throw error; } };

    await new AgentChatBridge(makeApp(true)).run('hello', sink);
    assert.deepEqual(capturedSkills, ['enabled']);

    capturedSkills = [];
    await new AgentChatBridge(makeApp(false)).run('hello', sink);
    assert.deepEqual(capturedSkills, []);
  } finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway serves health, static UI, and streamed SSE events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>taiwei test</title><img src="/logo.png?v={{ASSET_VERSION}}">');
  await writeFile(join(directory, 'app.js'), 'console.log("taiwei test")');
  await writeFile(join(directory, 'style.css'), 'body {}');
  await writeFile(join(directory, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const mock = new MockChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  let currentModel = 'good';
  const modelState: GatewayModelState = {
    getCurrentModel: async () => currentModel,
    resolveModels: async () => ({ models: ['good', 'free'], current: currentModel, source: 'config' }),
    setCurrentModel: async (model) => { currentModel = model; },
  };
  const server = createGatewayServer({
    chat: mock,
    sessions,
    modelState,
    contextWindow: async () => 1_000,
    publicDirectory: directory,
    uploadsDirectory: join(directory, 'uploads'),
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    assert.deepEqual(await (await fetch(`${baseUrl}/api/models`)).json(), { models: ['good', 'free'], current: 'good' });
    const switched = await fetch(`${baseUrl}/api/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free' }),
    });
    assert.deepEqual(await switched.json(), { ok: true, current: 'free', contextWindow: 1_000 });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/model`)).json(), { current: 'free' });
    const unknown = await fetch(`${baseUrl}/api/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(unknown.status, 400);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const pageBody = await page.text();
    assert.match(pageBody, /taiwei test/);
    assert.match(pageBody, /logo\.png\?v=10/);
    assert.doesNotMatch(pageBody, /\{\{ASSET_VERSION\}\}/);

    const stylesheet = await fetch(`${baseUrl}/style.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(stylesheet.headers.get('cache-control'), 'public, max-age=3600');

    const logo = await fetch(`${baseUrl}/logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('cache-control'), 'public, max-age=3600');
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const logoHead = await fetch(`${baseUrl}/logo.png`, { method: 'HEAD' });
    assert.equal(logoHead.status, logo.status);
    assert.equal(logoHead.headers.get('content-type'), logo.headers.get('content-type'));
    assert.equal(logoHead.headers.get('cache-control'), logo.headers.get('cache-control'));
    assert.equal(logoHead.headers.get('content-length'), logo.headers.get('content-length'));
    assert.equal((await logoHead.arrayBuffer()).byteLength, 0);

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; title: string };
    assert.equal(created.title, '新会话');

    const oversizedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'x-file-name': 'oversized.bin' }, body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    assert.equal(oversizedUpload.status, 413);

    const upload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('../notes.txt'), 'x-session-id': created.id },
      body: 'local attachment contents',
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { name: string; path: string; size: number; type: string };
    assert.equal(uploaded.name, 'notes.txt');
    assert.equal(uploaded.size, 25);
    assert.match(uploaded.path, /uploads/);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: created.id, files: [uploaded] }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await chat.text();
    assert.match(body, /event: token\ndata: \{"text":"Hello "\}/);
    assert.match(body, /event: tool\ndata: \{"name":"read","args":\{"path":"README.md"\}\}/);
    assert.match(body, /event: tool_result/);
    assert.match(body, /event: usage\ndata: \{"promptTokens":10,"completionTokens":2,"totalTokens":12,"contextWindow":1000,"model":"free"\}/);
    assert.match(body, new RegExp(`event: done\\ndata: \\{"text":"Hello world","sessionId":"${created.id}"\\}`));

    const detail = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const persisted = await detail.json() as {
      title: string;
      messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number; contextWindow: number; model: string };
    };
    assert.equal(persisted.title, 'hello');
    assert.deepEqual(persisted.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hello world' },
    ]);
    assert.match(mock.messages[0], /\[附件: notes\.txt\]/);
    assert.match(mock.messages[0], /local attachment contents/);
    assert.equal(persisted.messages[1].toolCalls?.length, 1);
    assert.deepEqual(persisted.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12, contextWindow: 1_000, model: 'free' });

    const secondChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'again', sessionId: created.id }),
    });
    assert.equal(secondChat.status, 200);
    assert.match(await secondChat.text(), /event: usage\ndata: \{"promptTokens":20,"completionTokens":4,"totalTokens":24,"contextWindow":1000,"model":"free"\}/);
    assert.match(mock.histories[1][0].content ?? '', /local attachment contents/);
    assert.deepEqual(mock.histories[1][1], { role: 'assistant', content: 'Hello world' });

    const listed = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{ id: string; messageCount: number }>;
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].messageCount, 4);

    const removed = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/sessions/${created.id}`)).status, 404);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway lists skills and safely manages knowledge files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-resources-test-'));
  const knowledgeDirectory = join(directory, 'knowledge');
  const nestedDirectory = join(knowledgeDirectory, 'guides');
  const skillPath = join(directory, 'skills', 'review', 'SKILL.md');
  await mkdir(nestedDirectory, { recursive: true });
  await mkdir(join(directory, 'skills', 'review'), { recursive: true });
  await writeFile(join(nestedDirectory, 'intro.md'), '# Intro\n\nKnowledge text');
  await writeFile(skillPath, '---\nname: review\ndescription: Review code\n---\n\n# Review\n');
  const skill = { name: 'review', description: 'Review code', body: '# Review', path: skillPath };
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    knowledgeDirectory,
    ragIndexPath: join(directory, 'rag-index.json'),
    skillLoader: { list: async () => [skill], load: async (name: string) => {
      if (name !== 'review') throw new Error(`Skill not found: ${name}`);
      return skill;
    } },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const skills = await (await fetch(`${baseUrl}/api/skills`)).json();
    assert.deepEqual(skills, { skills: [{ name: 'review', description: 'Review code', enabled: true }] });
    const detail = await (await fetch(`${baseUrl}/api/skills/review`)).json() as { content: string };
    assert.match(detail.content, /name: review/);
    assert.equal((await fetch(`${baseUrl}/api/skills/missing`)).status, 404);

    const initial = await (await fetch(`${baseUrl}/api/knowledge`)).json() as {
      files: Array<{ path: string; size: number; mtime: string }>;
      index: { exists: boolean; chunks: number; hasVectors: boolean };
    };
    assert.equal(initial.files[0].path, 'guides/intro.md');
    assert.ok(initial.files[0].size > 0);
    assert.equal(initial.index.exists, false);

    const invalidUpload = await fetch(`${baseUrl}/api/knowledge/upload`, {
      method: 'POST', headers: { 'x-file-name': 'notes.pdf' }, body: 'not allowed',
    });
    assert.equal(invalidUpload.status, 400);
    const upload = await fetch(`${baseUrl}/api/knowledge/upload`, {
      method: 'POST', headers: { 'x-file-name': encodeURIComponent('../notes.txt') }, body: 'uploaded knowledge',
    });
    assert.equal(upload.status, 201);
    assert.deepEqual(await upload.json(), { path: 'notes.txt' });
    assert.equal((await stat(join(knowledgeDirectory, 'notes.txt'))).isFile(), true);

    const traversal = await fetch(`${baseUrl}/api/knowledge?path=${encodeURIComponent('../outside.md')}`, { method: 'DELETE' });
    assert.equal(traversal.status, 400);
    const deleted = await fetch(`${baseUrl}/api/knowledge?path=${encodeURIComponent('notes.txt')}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true });
    assert.equal((await fetch(`${baseUrl}/api/knowledge?path=${encodeURIComponent('notes.txt')}`, { method: 'DELETE' })).status, 404);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway skill and tool APIs validate and persist merged enable/config updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-tool-management-test-'));
  const skillPath = join(directory, 'skills', 'review', 'SKILL.md');
  await mkdir(join(directory, 'skills', 'review'), { recursive: true });
  await writeFile(skillPath, '---\nname: review\ndescription: Review code\n---\n\n# Review\n');
  const skill = { name: 'review', description: 'Review code', body: '# Review', path: skillPath };
  let config: TaiweiConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    tools: { configurable: { enabled: true, limit: 2, preserved: 'value' } },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: 'configurable', description: 'Configurable test tool', parameters: { type: 'object' },
    configSchema: { limit: { type: 'number', default: 5, label: 'Limit', min: 1, max: 20 } },
    execute: (_args, context) => context.toolConfig,
  });
  registry.configure(config.tools);
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    toolRegistry: registry,
    skillLoader: {
      list: async () => [skill],
      load: async (name: string) => {
        if (name !== 'review') throw new Error(`Skill not found: ${name}`);
        return skill;
      },
    },
    configState: {
      load: async () => structuredClone(config),
      save: async (next) => { config = structuredClone(next); },
    },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('/api/skills/missing', { enabled: false })).status, 404);
    assert.equal((await post('/api/skills/review', { enabled: 'no' })).status, 400);
    const disabledSkill = await post('/api/skills/review', { enabled: false });
    assert.deepEqual(await disabledSkill.json(), { ok: true, enabled: false });
    assert.deepEqual(config.skillsDisabled, ['review']);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/skills`)).json(), {
      skills: [{ name: 'review', description: 'Review code', enabled: false }],
    });

    const listed = await (await fetch(`${baseUrl}/api/tools`)).json() as { tools: Array<{ name: string; enabled: boolean; configurable: boolean; config: { limit: number } }> };
    assert.equal(listed.tools[0]?.name, 'configurable');
    assert.equal(listed.tools[0]?.enabled, true);
    assert.equal(listed.tools[0]?.configurable, true);
    assert.deepEqual(listed.tools[0]?.config, { limit: 2 });
    assert.equal((await post('/api/tools/missing', { enabled: false })).status, 404);
    assert.equal((await post('/api/tools/configurable', { config: { unknown: 1 } })).status, 400);

    const disabledTool = await post('/api/tools/configurable', { enabled: false });
    assert.deepEqual(await disabledTool.json(), { ok: true, enabled: false, config: { limit: 2 } });
    const configuredTool = await post('/api/tools/configurable', { config: { limit: 7 } });
    assert.deepEqual(await configuredTool.json(), { ok: true, enabled: false, config: { limit: 7 } });
    assert.deepEqual(config.tools?.configurable, { enabled: false, limit: 7, preserved: 'value' });
    assert.equal(registry.isEnabled('configurable'), false);
    const reloaded = await fetch(`${baseUrl}/api/tools/reload`, { method: 'POST' });
    assert.equal(reloaded.status, 200);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway MCP API validates, updates, redacts env values, preserves secrets, and deletes configs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-mcp-test-'));
  const mcpConfigPath = join(directory, 'mcp.json');
  await writeFile(mcpConfigPath, JSON.stringify([{
    name: 'alpha', transport: 'stdio', command: 'node', args: ['server.js'], env: { API_TOKEN: 'top-secret' }, enabled: true,
  }], null, 2));
  const mcpBridge = new MockMcpBridge();
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    mcpConfigPath,
    mcpBridge,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (body: unknown) => fetch(`${baseUrl}/api/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const listedResponse = await fetch(`${baseUrl}/api/mcp`);
    assert.equal(listedResponse.status, 200);
    const listedText = await listedResponse.text();
    assert.doesNotMatch(listedText, /top-secret/);
    const listed = JSON.parse(listedText) as { servers: Array<{ name: string; envKeys: string[]; env?: unknown }>; statuses: unknown[] };
    assert.deepEqual(listed.servers, [{ name: 'alpha', transport: 'stdio', command: 'node', args: ['server.js'], enabled: true, envKeys: ['API_TOKEN'] }]);
    assert.equal('env' in listed.servers[0], false);
    assert.equal(mcpBridge.reloads, 1);

    assert.equal((await post({ transport: 'stdio', command: 'node' })).status, 400);
    assert.equal((await post({ name: 'invalid transport', transport: 'websocket' })).status, 400);
    assert.equal((await post({ name: 'missing_command', transport: 'stdio' })).status, 400);

    const preserved = await post({ name: 'alpha', transport: 'stdio', command: 'bun', env: {}, enabled: false });
    assert.equal(preserved.status, 200);
    let stored = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as Array<{ name: string; command: string; env?: Record<string, string>; enabled: boolean }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].command, 'bun');
    assert.equal(stored[0].enabled, false);
    assert.deepEqual(stored[0].env, { API_TOKEN: 'top-secret' });

    const replaced = await post({ name: 'alpha', transport: 'sse', url: 'https://example.test/sse', env: { REGION: 'west' }, enabled: true });
    assert.equal(replaced.status, 200);
    stored = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal((stored[0] as unknown as { transport: string }).transport, 'sse');
    assert.deepEqual(stored[0].env, { REGION: 'west' });

    const tested = await fetch(`${baseUrl}/api/mcp/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alpha' }),
    });
    assert.deepEqual(await tested.json(), { connected: true, detail: '2 tools' });

    assert.equal((await fetch(`${baseUrl}/api/mcp?name=missing`, { method: 'DELETE' })).status, 404);
    const deleted = await fetch(`${baseUrl}/api/mcp?name=alpha`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const deletedBody = await deleted.json() as { ok: boolean; servers: unknown[] };
    assert.equal(deletedBody.ok, true);
    assert.deepEqual(deletedBody.servers, []);
    assert.deepEqual(JSON.parse(await readFile(mcpConfigPath, 'utf8')), []);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway settings persist workspace/security changes and confirmation pauses until approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-settings-test-'));
  const workspace = join(directory, 'new-workspace');
  const hookScript = join(directory, 'test-hook.cjs');
  await writeFile(hookScript, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ extraContext: 'tested' })));`);
  let config = structuredClone(DEFAULT_CONFIG) as TaiweiConfig;
  const configState = {
    load: async () => structuredClone(config),
    save: async (value: TaiweiConfig) => { config = structuredClone(value); },
  };
  const server = createGatewayServer({
    chat: new ConfirmingChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    configState,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: { dir: workspace },
        security: { enabled: true, timeoutSeconds: 15, remember: 'session', patterns: ['deploy\\s+prod'] },
        hooks: { beforeMessage: [], beforeLLM: [], afterLLM: [`node ${JSON.stringify(hookScript)}`], beforeTool: [], afterTool: [] },
        hookTimeoutSeconds: 12,
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(config.workspace.dir, workspace);
    assert.deepEqual(config.security.patterns, ['deploy\\s+prod']);
    assert.equal(config.security.timeoutSeconds, 15);
    assert.equal(config.hookTimeoutSeconds, 12);
    assert.equal(config.hooks.afterLLM.length, 1);
    assert.equal((await stat(workspace)).isDirectory(), true);

    const hookTest = await fetch(`${baseUrl}/api/hooks/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'afterLLM', command: config.hooks.afterLLM[0] }),
    });
    assert.equal(hookTest.status, 200);
    const hookResult = await hookTest.json() as { exitCode: number; response?: { extraContext?: string } };
    assert.equal(hookResult.exitCode, 0);
    assert.equal(hookResult.response?.extraContext, 'tested');

    const session = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json() as { id: string };
    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'danger', sessionId: session.id }),
    });
    assert.equal(chat.status, 200);
    const approval = await fetch(`${baseUrl}/api/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'confirmation-1', approve: true, remember: 'session' }),
    });
    assert.equal(approval.status, 200);
    const stream = await chat.text();
    assert.match(stream, /event: confirm\ndata: \{"id":"confirmation-1","command":"shutdown -h now"/);
    assert.match(stream, /event: done\ndata: \{"text":"approved"/);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('beforeMessage hook blocks gateway chat before persistence and agent execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-before-message-hook-test-'));
  const script = join(directory, 'block-message.cjs');
  await writeFile(script, `let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const payload = JSON.parse(input); process.stdout.write(JSON.stringify({ block: payload.message === 'blocked', reason: 'message policy' })); });`);
  const config = structuredClone(DEFAULT_CONFIG) as TaiweiConfig;
  config.workspace.dir = directory;
  config.hooks.beforeMessage = [`node ${JSON.stringify(script)}`];
  const chat = new MockChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  const server = createGatewayServer({
    chat,
    sessions,
    uploadsDirectory: join(directory, 'uploads'),
    hooks: new HookRunner(config.hooks, config.hookTimeoutSeconds, directory, () => {}),
    configState: { load: async () => structuredClone(config), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const session = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' })).json() as { id: string };
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'blocked', sessionId: session.id }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'message policy', blockedByHook: true });
    assert.equal(chat.messages.length, 0);
    const stored = await sessions.get(session.id);
    assert.equal(stored?.messages.length, 0);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway authenticates API requests and preserves tokens across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-auth-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>taiwei auth test</title>');
  await writeFile(join(directory, 'app.js'), '');
  await writeFile(join(directory, 'style.css'), '');
  const authFile = join(directory, 'gateway-sessions.json');
  const lockFile = join(directory, 'login-locks.json');
  const options = {
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    publicDirectory: directory,
    uploadsDirectory: join(directory, 'uploads'),
    auth: { enabled: true, username: 'admin', password: 'correct horse' },
    log: () => {},
  };
  let server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile), loginLocks: new LoginLockStore(lockFile) });
  let port = await listenGateway(server, '127.0.0.1', 0);
  let baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/models`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/settings`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/hooks/test`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/confirm`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { 'x-file-name': 'private.txt' }, body: 'private' })).status, 401);

    const wrong = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct horse' }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json() as { token: string };
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.match(login.headers.get('set-cookie') ?? '', /taiwei_token=.*HttpOnly.*SameSite=Lax.*Max-Age=604800/);

    const authorized = await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authorized.status, 200);
    const info = await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await info.json() as { username?: string }).username, 'admin');
    const cookieAuthorized = await fetch(`${baseUrl}/api/sessions`, { headers: { cookie: `taiwei_token=${token}` } });
    assert.equal(cookieAuthorized.status, 200);
    const authorizedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-file-name': 'private.txt', 'content-type': 'text/plain' }, body: 'private',
    });
    assert.equal(authorizedUpload.status, 201);

    await closeGateway(server);
    server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile), loginLocks: new LoginLockStore(lockFile) });
    port = await listenGateway(server, '127.0.0.1', 0);
    baseUrl = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

    const logout = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway login migrates a legacy plaintext password to scrypt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-password-migration-test-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'legacy secret' };
  const configState = {
    load: async () => structuredClone(config),
    save: async (next: TaiweiConfig) => { config.auth = structuredClone(next.auth); },
  };
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')),
    auth: config.auth,
    configState,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'legacy secret' }),
    });
    assert.equal(login.status, 200);
    assert.match(config.auth.password, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    assert.ok(isScryptPassword(config.auth.password));
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway login verifies a scrypt password', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-scrypt-login-test-'));
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')),
    auth: { enabled: true, username: 'admin', password: hashPassword('hashed secret') },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hashed secret' }),
    });
    assert.equal(login.status, 200);
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway login returns 429 after five failed account and IP attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-lock-route-test-'));
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')),
    auth: { enabled: true, username: 'admin', password: 'secret' },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const login = () => fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await login()).status, 401);
    const locked = await login();
    assert.equal(locked.status, 429);
    assert.deepEqual(await locked.json(), { error: '失败次数过多，请稍后再试' });
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('login lock store enforces cooldown, permanent pair locks, IP-wide locks, and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-login-lock-store-test-'));
  const file = join(directory, 'login-locks.json');
  const store = new LoginLockStore(file);
  const start = 1_000_000;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await store.attempt('admin', 'pair-ip', false, start + attempt), { failed: true });
    }
    assert.equal((await store.attempt('admin', 'pair-ip', true, start + 10)).lock, 'pair_cooldown');

    const secondWindow = start + LOGIN_COOLDOWN_MS + 100;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await store.attempt('admin', 'pair-ip', false, secondWindow + attempt), { failed: true });
    }
    assert.equal((await store.attempt('admin', 'pair-ip', true, secondWindow + 10)).lock, 'pair_permanent');
    const restarted = new LoginLockStore(file);
    assert.equal((await restarted.attempt('admin', 'pair-ip', true, secondWindow + LOGIN_COOLDOWN_MS + 20)).lock, 'pair_permanent');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.deepEqual(await store.attempt(`user-${attempt}`, 'shared-ip', false, start + attempt), { failed: true });
    }
    assert.equal((await store.attempt('valid-user', 'shared-ip', true, start + 20)).lock, 'ip_cooldown');
    assert.deepEqual(await store.attempt('valid-user', 'shared-ip', true, start + LOGIN_COOLDOWN_MS + 30), { failed: false });

    await store.attempt('reset-user', 'reset-ip', false, start);
    assert.deepEqual(await store.attempt('reset-user', 'reset-ip', true, start + 1), { failed: false });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.deepEqual(await store.attempt('reset-user', 'reset-ip', false, start + 2 + attempt), { failed: true });
    }
    assert.deepEqual(await store.attempt('reset-user', 'reset-ip', true, start + 10), { failed: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
