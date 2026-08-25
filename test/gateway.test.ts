import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import type { AgentEvent } from '../src/agent/loop.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { AgentChatBridge, type ChatBridge, type ChatSink } from '../src/gateway/chat.js';
import { LOGIN_COOLDOWN_MS, LoginLockStore } from '../src/gateway/login-locks.js';
import { closeGateway, createGatewayServer, formatGatewayTurnError, guestIdForUsername, guestRouteAllowed, listenGateway } from '../src/gateway/server.js';
import { createOssObjectKey } from '../src/gateway/oss.js';
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
import { createMemoryTools, writeExtendedMemory } from '../src/tools/impl/memory.js';
import { installGatewayTestAdminAuth, invalidGatewayAuthHeader } from './gateway-test-auth.js';
import { ProviderHttpError } from '../src/llm/retry.js';

installGatewayTestAdminAuth();

test('gateway assistant media filter only removes matching generator output', async () => {
  const frontendSource = await readFile(join(import.meta.dirname, '..', 'src', 'gateway', 'public', 'app.js'), 'utf8');
  const helperSource = frontendSource.slice(
    frontendSource.indexOf("const MEDIA_GENERATION_TOOLS"),
    frontendSource.indexOf('function inlineMarkdown'),
  );
  const helpers = Function(`${helperSource}\nreturn { mediaDownloadFilename, mediaUrlsFromResult, removeMediaReferences, generatedMediaUrls };`)() as {
    mediaDownloadFilename(url: string, kind: 'image' | 'video', index: number): string;
    mediaUrlsFromResult(result: string): string[];
    removeMediaReferences(source: string, urls: string[]): string;
    generatedMediaUrls(calls: Array<{ name: string; result: string }>): string[];
  };
  const generatedUrl = 'https://cdn.example/generated.png';
  const manualUrl = 'https://example.com/manual.png';
  const toolCalls = [{ name: 'generate_image', result: `图片生成成功：\n![生成的图片](${generatedUrl})` }];
  const urls = helpers.generatedMediaUrls(toolCalls);
  assert.deepEqual(urls, [generatedUrl]);
  const filtered = helpers.removeMediaReferences(`已完成\n![生成的图片](${generatedUrl})\n![用户图片](${manualUrl})`, urls);
  assert.doesNotMatch(filtered, /generated\.png/);
  assert.match(filtered, /!\[用户图片\]\(https:\/\/example\.com\/manual\.png\)/);
  assert.equal(helpers.removeMediaReferences(`![用户图片](${manualUrl})`, []), `![用户图片](${manualUrl})`);
  assert.deepEqual(helpers.mediaUrlsFromResult('[▶️ 查看视频](https://cdn.example/result.mp4)\nhttps://cdn.example/result.mp4'), ['https://cdn.example/result.mp4']);
  assert.equal(helpers.mediaDownloadFilename('data:image/jpeg;base64,AA==', 'image', 2), 'taiwei-image-2.jpg');
  assert.equal(helpers.mediaDownloadFilename('https://cdn.example/result.webm?token=secret', 'video', 3), 'taiwei-video-3.webm');
  assert.equal(helpers.mediaDownloadFilename('https://cdn.example/result', 'video', 1), 'taiwei-video-1.mp4');
});

class MockChat implements ChatBridge {
  stopped = false;
  histories: ChatMessage[][] = [];
  messages: string[] = [];
  workspaceRoots: Array<string | undefined> = [];

  async run(message: string, sink: ChatSink, history: ChatMessage[] = [], _sessionId?: string, _memory?: MemoryStore, _agentId?: string, _role?: 'admin' | 'guest', _identity?: string, _runtimeSessionId?: string, _providerId?: string, _model?: string, workspaceRoot?: string, _userContent?: import('../src/llm/client.js').ContentBlock[]): Promise<void> {
    this.messages.push(message);
    this.histories.push(history);
    this.workspaceRoots.push(workspaceRoot);
    for (const event of [
      { type: 'token', text: 'Hello ' },
      { type: 'tool', name: 'read', args: { path: 'README.md' } },
      { type: 'tool_result', name: 'read', result: 'contents' },
      { type: 'token', text: 'world' },
      { type: 'compressing' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, contextWindow: 1_000 }, model: 'free', compressed: true },
      { type: 'done', text: 'Hello world' },
    ] satisfies AgentEvent[]) sink.event(event);
    sink.context?.([...history, { role: 'user', content: message }, { role: 'assistant', content: 'Hello world' }]);
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

test('gateway chat indexes only enabled skills by default without injecting bodies and honors autoLoadSkills=false', async () => {
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
    let capturedPrompt = '';
    const makeApp = (autoLoadSkills: boolean) => ({
      config: { ...structuredClone(DEFAULT_CONFIG), autoLoadSkills },
      memory,
      skills,
      context: new AgentContext(memory, skills),
      run: async (_message: string, options: { context?: AgentContext }) => {
        capturedPrompt = await options.context?.systemPrompt() ?? '';
        return 'done';
      },
      interrupt: { cancel: () => false },
    }) as unknown as TaiweiApp;
    const sink: ChatSink = { event: () => {}, error: (error) => { throw error; } };

    await new AgentChatBridge(makeApp(true)).run('hello', sink);
    assert.match(capturedPrompt, /Available skills:\n- enabled: Enabled skill/);
    assert.match(capturedPrompt, /Call load_skill\(name\) to load a skill's full instructions before using it\./);
    assert.doesNotMatch(capturedPrompt, /Active skills:/);
    assert.doesNotMatch(capturedPrompt, /\nEnabled(?:\n|$)/);
    assert.doesNotMatch(capturedPrompt, /disabled/i);

    capturedPrompt = '';
    await new AgentChatBridge(makeApp(false)).run('hello', sink);
    assert.doesNotMatch(capturedPrompt, /Available skills:/);
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
  const indexedSessions: Array<{ id: string; source?: string; model?: string }> = [];
  const indexedMessages: Array<{ sessionId: string; role: string; toolName?: string | null }> = [];
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
    configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
    history: {
      upsertSession: async (session) => { indexedSessions.push(session); },
      appendMessage: async (message) => { indexedMessages.push(message); },
    },
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
    assert.match(pageBody, /logo\.png\?v=\d+/);
    assert.doesNotMatch(pageBody, /\{\{ASSET_VERSION\}\}/);

    const stylesheet = await fetch(`${baseUrl}/style.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(stylesheet.headers.get('cache-control'), 'public, max-age=3600');

    const frontendSource = await readFile(join(import.meta.dirname, '..', 'src', 'gateway', 'public', 'app.js'), 'utf8');
    assert.match(frontendSource, /type, content, contentTruncated/);
    assert.match(frontendSource, /function makeLocalId\(\)/);
    assert.match(frontendSource, /function ownsCurrentStream\(sessionId, controller\)/);
    assert.match(frontendSource, /if \(!ownsCurrentStream\(sessionId, controller\)\) continue;/);
    assert.doesNotMatch(frontendSource, /state\.current\.id = item\.data\.sessionId/);
    assert.doesNotMatch(frontendSource, /crypto\.randomUUID/);
    assert.match(frontendSource, /MEDIA_GENERATION_TOOLS = new Set\(\['generate_image', 'generate_video'\]\)/);
    assert.match(frontendSource, /renderAssistantMarkdown\(message\.content \|\| '', message\.toolCalls\)/);
    assert.match(frontendSource, /renderToolDetail\(detail, args, result, toolName = ''\)/);
    assert.match(frontendSource, /function makeMediaDownloadButton\(url, kind, index\)/);
    assert.match(frontendSource, /decorateMediaDownloads\(gallery\)/);
    assert.match(frontendSource, /decorateMediaDownloads\(bubble\)/);
    assert.match(frontendSource, /URL\.createObjectURL\(await response\.blob\(\)\)/);
    const frontendHtml = await readFile(join(import.meta.dirname, '..', 'src', 'gateway', 'public', 'index.html'), 'utf8');
    assert.match(frontendHtml, /class="attachment-button" id="attachment-button"/);
    assert.doesNotMatch(frontendHtml, /class="attachment-button admin-only"/);

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

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      id: string;
      title: string;
      currentModel?: string;
      identity?: { role: string; username: string };
    };
    assert.equal(created.title, '新会话');
    assert.equal(created.currentModel, 'free');
    assert.deepEqual(created.identity, { role: 'admin', username: 'admin' });

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
    const uploaded = await upload.json() as { name: string; path: string; size: number; type: string; content?: string; contentTruncated?: boolean };
    assert.equal(uploaded.name, 'notes.txt');
    assert.equal(uploaded.size, 25);
    assert.match(uploaded.path, /uploads/);
    assert.equal((uploaded as { url?: string }).url, undefined);
    assert.equal(uploaded.content, 'local attachment contents');
    assert.equal(uploaded.contentTruncated, undefined);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: created.id, files: [uploaded] }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await chat.text();
    assert.match(body, /event: token\ndata: \{"text":"Hello "\}/);
    assert.match(body, /event: tool\ndata: \{"name":"read","args":\{"path":"README.md"\}\}/);
    assert.match(body, /event: tool_result/);
    assert.match(body, /event: compressing\ndata: \{\}/);
    assert.match(body, /event: usage\ndata: \{"promptTokens":10,"completionTokens":2,"totalTokens":12,"contextWindow":1000,"model":"free","compressed":true\}/);
    assert.match(body, new RegExp(`event: done\\ndata: \\{"text":"Hello world","sessionId":"${created.id}"\\}`));

    const detail = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    const persisted = await detail.json() as {
      title: string;
      messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number; contextWindow: number; model: string; compressed?: boolean };
    };
    assert.equal(persisted.title, 'hello');
    assert.deepEqual(persisted.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hello world' },
    ]);
    assert.match(mock.messages[0], /\[附件: notes\.txt\]\nlocal attachment contents/);
    assert.equal(persisted.messages[1].toolCalls?.length, 1);
    assert.deepEqual(persisted.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12, contextWindow: 1_000, model: 'free', compressed: true });
    assert.equal(indexedSessions[0]?.id, created.id);
    assert.equal(indexedSessions[0]?.source, 'gateway');
    assert.equal(indexedSessions[0]?.model, 'free');
    assert.deepEqual(indexedMessages.map(({ role, toolName }) => ({ role, toolName })), [
      { role: 'user', toolName: undefined },
      { role: 'assistant', toolName: undefined },
      { role: 'tool', toolName: 'read' },
    ]);

    const secondChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'again', sessionId: created.id }),
    });
    assert.equal(secondChat.status, 200);
    assert.match(await secondChat.text(), /event: usage\ndata: \{"promptTokens":10,"completionTokens":2,"totalTokens":12,"contextWindow":1000,"model":"free","compressed":true\}/);
    assert.match(typeof mock.histories[1][0].content === 'string' ? mock.histories[1][0].content : JSON.stringify(mock.histories[1][0].content), /\[附件: notes\.txt\]\nlocal attachment contents/);
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

test('gateway hides admin-only models from guests and rejects guest selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-admin-only-model-test-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'secret' };
  const capabilities = { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 32_000 };
  const models = [
    { id: 'premium', provider: 'main', displayName: 'Premium', capabilities, adminOnly: true },
    { id: 'public', provider: 'main', displayName: 'Public', capabilities },
  ];
  const modelState: GatewayModelState = {
    getCurrentModel: async () => 'premium',
    resolveModels: async () => ({
      models: ['premium', 'public'], current: 'premium', currentProvider: 'main', source: 'config',
      providers: [{ id: 'main', name: 'Main', models }],
    }),
    setCurrentModel: async () => {},
  };
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const guestToken = await authSessions.create('guest-user', 'guest');
  const adminToken = await authSessions.create('admin', 'admin');
  const server = createGatewayServer({
    chat: new MockChat(), auth: config.auth, authSessions, modelState,
    configState: { load: async () => structuredClone(config), save: async () => {} },
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const guestHeaders = { authorization: `Bearer ${guestToken}` };
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  try {
    const guestCatalog = await (await fetch(`${baseUrl}/api/models`, { headers: guestHeaders })).json() as {
      models: string[]; current: string; currentProvider: string; providers: Array<{ models: Array<{ id: string; adminOnly?: boolean }> }>;
    };
    assert.deepEqual(guestCatalog.models, ['public']);
    assert.equal(guestCatalog.current, 'public');
    assert.equal(guestCatalog.currentProvider, 'main');
    assert.deepEqual(guestCatalog.providers[0].models.map((model) => model.id), ['public']);
    assert.doesNotMatch(JSON.stringify(guestCatalog), /premium/);

    const adminCatalog = await (await fetch(`${baseUrl}/api/models`, { headers: adminHeaders })).json() as {
      providers: Array<{ models: Array<{ id: string }> }>;
    };
    assert.deepEqual(adminCatalog.providers[0].models.map((model) => model.id), ['premium', 'public']);

    for (const path of ['/api/model', '/api/sessions']) {
      const denied = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { ...guestHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'main', model: 'premium' }),
      });
      assert.equal(denied.status, 403, path);
      assert.deepEqual(await denied.json(), { error: 'Guest cannot select this model' });
    }
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('OSS text uploads inject bounded content for non-vision chat and reject forged attachment content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-oss-text-test-'));
  const mock = new MockChat();
  const config = structuredClone(DEFAULT_CONFIG);
  config.oss = {
    enabled: true,
    accessKeyId: 'test-id',
    accessKeySecret: 'test-secret',
    bucket: 'test-bucket',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    prefix: 'taiwei',
  };
  const server = createGatewayServer({
    chat: mock,
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    configState: { load: async () => structuredClone(config), save: async () => {} },
    ossUpload: async (_data, filename) => ({
      url: `https://test-bucket.oss-cn-hangzhou.aliyuncs.com/taiwei/${encodeURIComponent(filename)}`,
      objectKey: `taiwei/${filename}`,
    }),
    history: false,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const session = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json() as { id: string };
    const source = `real body ${'x'.repeat(8_001)}`;
    const upload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': 'notes.txt' }, body: source,
    });
    assert.equal(upload.status, 201);
    const textFile = await upload.json() as { path: string; url: string; content: string; contentTruncated: boolean };
    assert.match(textFile.url, /^https:\/\//);
    assert.equal(textFile.path, textFile.url);
    assert.equal(textFile.content.length, 8_000);
    assert.equal(textFile.content, source.slice(0, 8_000));
    assert.equal(textFile.contentTruncated, true);

    const textChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'read it', sessionId: session.id, files: [textFile] }),
    });
    assert.equal(textChat.status, 200);
    await textChat.text();
    assert.match(mock.messages[0], /\[附件: notes\.txt\]\nreal body /);
    assert.match(mock.messages[0], /\n\[内容已截断\]/);

    const binaryUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'archive.bin' },
      body: Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    });
    const binaryFile = await binaryUpload.json() as { path: string; content?: string };
    assert.equal(binaryFile.content, undefined);
    const binaryChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'inspect it', sessionId: session.id, files: [binaryFile] }),
    });
    assert.equal(binaryChat.status, 200);
    await binaryChat.text();
    assert.match(mock.messages[1], /\[附件\] archive\.bin: https:\/\//);
    assert.doesNotMatch(mock.messages[1], /��/);

    for (const files of [
      [{ name: 'forged.txt', path: 'https://example.com/forged.txt', type: 'text/plain', content: 'x'.repeat(8_001) }],
      [{ name: 'archive.zip', path: 'https://example.com/archive.zip', type: 'application/zip', content: 'forged' }],
      Array.from({ length: 6 }, (_, index) => ({ name: `${index}.txt`, path: `https://example.com/${index}.txt`, type: 'text/plain', content: 'ok' })),
    ]) {
      const rejected = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'forged', sessionId: session.id, files }),
      });
      assert.equal(rejected.status, 400);
    }
  } finally {
    await closeGateway(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest uploads are allowed, size-limited, and use identity-isolated OSS keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-guest-upload-test-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const authSessions = new AuthSessionStore(join(directory, 'gateway-sessions.json'));
  const guestToken = await authSessions.create('Alice.Example', 'guest');
  const adminToken = await authSessions.create('admin', 'admin');
  const config = structuredClone(DEFAULT_CONFIG);
  config.oss = {
    enabled: true,
    accessKeyId: 'test-id',
    accessKeySecret: 'test-secret',
    bucket: 'test-bucket',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    prefix: 'taiwei',
  };
  const objectKeys: string[] = [];
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    auth: { enabled: true, username: 'admin', password: hashPassword('secret') },
    authSessions,
    uploadsDirectory: join(directory, 'uploads'),
    configState: { load: async () => structuredClone(config), save: async () => {} },
    ossUpload: async (_data, filename, _type, ossConfig, override) => {
      const objectKey = createOssObjectKey(filename, override?.prefix ?? ossConfig.prefix, 123, 'deadbeef');
      objectKeys.push(objectKey);
      return { objectKey, url: `https://test-bucket.example/${objectKey}` };
    },
    history: false,
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal(guestRouteAllowed('POST', '/api/upload'), true);
    assert.equal(guestRouteAllowed('GET', '/api/skills'), true);
    assert.equal(guestRouteAllowed('POST', '/api/skills'), false);

    const guestUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${guestToken}`, 'x-file-name': 'guest.txt', 'content-type': 'text/plain' }, body: 'guest',
    });
    assert.equal(guestUpload.status, 201);
    assert.match(objectKeys[0], new RegExp(`^taiwei/guests/${guestIdForUsername('Alice.Example')}/`));

    const adminUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'x-file-name': 'admin.txt', 'content-type': 'text/plain' }, body: 'admin',
    });
    assert.equal(adminUpload.status, 201);
    assert.match(objectKeys[1], /^taiwei\//);
    assert.doesNotMatch(objectKeys[1], /\/guests\//);

    const oversizedGuestUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${guestToken}`, 'x-file-name': 'large.bin' }, body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    assert.equal(oversizedGuestUpload.status, 413);
  } finally {
    await closeGateway(server);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway persists compressed agent context separately from the visible transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-context-test-'));
  const histories: ChatMessage[][] = [];
  const chat: ChatBridge = {
    async run(message, sink, history = []) {
      histories.push(history);
      sink.event({ type: 'done', text: `answer-${histories.length}` });
      sink.context?.(histories.length === 1
        ? [{ role: 'system', content: 'Conversation summary: durable fact' }, { role: 'user', content: message }, { role: 'assistant', content: 'answer-1' }]
        : [...history, { role: 'user', content: message }, { role: 'assistant', content: 'answer-2' }]);
    },
    stop: () => false,
  };
  const sessions = new SessionStore(join(directory, 'sessions'));
  const server = createGatewayServer({ chat, sessions, history: false, uploadsDirectory: join(directory, 'uploads'), log: () => {} });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const session = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json() as { id: string };
    for (const message of ['first', 'second']) {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, message }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(histories[1][0], { role: 'system', content: 'Conversation summary: durable fact' });
    const persisted = await sessions.get(session.id);
    assert.equal(persisted?.messages.length, 4);
    assert.equal(persisted?.contextMessages?.[0]?.role, 'system');
    assert.match(String(persisted?.contextMessages?.[0]?.content), /durable fact/);
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

test('gateway memory API reads, replaces, validates, and clears persistent memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-memory-test-'));
  const memoryPath = join(directory, 'memory.md');
  const initialContent = '# Durable facts\n\nThe user prefers concise answers.';
  await writeFile(memoryPath, initialContent, 'utf8');
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    uploadsDirectory: join(directory, 'uploads'),
    memoryStore: new MemoryStore(memoryPath),
    log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (body: unknown) => fetch(`${baseUrl}/api/memory`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const current = await (await fetch(`${baseUrl}/api/memory`)).json() as { content: string; chars: number; lines: number };
    assert.equal(current.content, initialContent);
    assert.equal(current.chars, initialContent.length);
    assert.equal(current.lines, 3);

    const replacement = 'Remember the project name.\nUse TypeScript.';
    const saved = await post({ content: replacement });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { chars: replacement.length, lines: 2 });
    assert.equal(await readFile(memoryPath, 'utf8'), replacement);
    assert.equal((await (await fetch(`${baseUrl}/api/memory`)).json() as { content: string }).content, replacement);

    assert.equal((await post({ content: 42 })).status, 400);
    assert.equal((await post({ content: 'x'.repeat(50_001) })).status, 413);
    assert.equal(await readFile(memoryPath, 'utf8'), replacement);

    const cleared = await fetch(`${baseUrl}/api/memory`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { ok: true });
    assert.equal(await readFile(memoryPath, 'utf8'), '');
    const empty = await (await fetch(`${baseUrl}/api/memory`)).json() as { content: string; chars: number; lines: number };
    assert.deepEqual({ content: empty.content, chars: empty.chars, lines: empty.lines }, { content: '', chars: 0, lines: 0 });
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

    const customPromptSaved = await fetch(`${baseUrl}/api/settings/custom-prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customPrompt: 'Always explain command risks.' }),
    });
    assert.equal(customPromptSaved.status, 200);
    assert.deepEqual(await customPromptSaved.json(), { customPrompt: 'Always explain command risks.' });
    assert.equal(config.customPrompt, 'Always explain command risks.');
    const customPromptLoaded = await fetch(`${baseUrl}/api/settings/custom-prompt`);
    assert.deepEqual(await customPromptLoaded.json(), { customPrompt: 'Always explain command risks.' });
    assert.equal((await fetch(`${baseUrl}/api/settings/custom-prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customPrompt: 42 }),
    })).status, 400);

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
    assert.ok(chat.body);
    const reader = chat.body.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    while (!stream.includes('event: confirm')) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      stream += decoder.decode(value, { stream: true });
    }
    const approval = await fetch(`${baseUrl}/api/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'confirmation-1', approve: true, remember: 'session' }),
    });
    assert.equal(approval.status, 200);
    for (;;) {
      const { done, value } = await reader.read();
      stream += decoder.decode(value, { stream: !done });
      if (done) break;
    }
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
  let authConfig = structuredClone(DEFAULT_CONFIG);
  authConfig.auth = { enabled: true, username: 'admin', password: 'correct horse' };
  const options = {
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    publicDirectory: directory,
    uploadsDirectory: join(directory, 'uploads'),
    auth: authConfig.auth,
    configState: { load: async () => structuredClone(authConfig), save: async (next: TaiweiConfig) => { authConfig = structuredClone(next); } },
    log: () => {},
  };
  let server = createGatewayServer({ ...options, authSessions: new AuthSessionStore(authFile), loginLocks: new LoginLockStore(lockFile) });
  let port = await listenGateway(server, '127.0.0.1', 0);
  let baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: invalidGatewayAuthHeader })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/models`, { headers: invalidGatewayAuthHeader })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/settings`, { headers: invalidGatewayAuthHeader })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/settings/custom-prompt`, { headers: invalidGatewayAuthHeader })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/hooks/test`, { method: 'POST', headers: invalidGatewayAuthHeader })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/confirm`, { method: 'POST', headers: invalidGatewayAuthHeader })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { ...invalidGatewayAuthHeader, 'x-file-name': 'private.txt' }, body: 'private' })).status, 401);

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
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: hashPassword('hashed secret') };
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')),
    auth: config.auth,
    configState: { load: async () => structuredClone(config), save: async () => {} },
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
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'secret' };
  const server = createGatewayServer({
    chat: new MockChat(),
    sessions: new SessionStore(join(directory, 'sessions')),
    authSessions: new AuthSessionStore(join(directory, 'gateway-sessions.json')),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')),
    auth: config.auth,
    configState: { load: async () => structuredClone(config), save: async () => {} },
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

test('ai-connect OAuth guests are chat-only, legacy guest login is removed, and share access still works', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-share-guest-test-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  let tokenRequestBody = '';
  let userinfoAuthorization = '';
  const provider = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/oauth/token') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      tokenRequestBody = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'provider-access-token', token_type: 'Bearer', expires_in: 3600, username: 'alice' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/oauth/userinfo') {
      userinfoAuthorization = request.headers.authorization ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ username: 'Alice.Example' }));
      return;
    }
    response.writeHead(404).end();
  });
  const providerPort = await listenGateway(provider, '127.0.0.1', 0);
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, username: 'admin', password: 'admin-secret' };
  config.oauth = { ...config.oauth, enabled: true, providerBaseUrl: `http://127.0.0.1:${providerPort}` };
  const legacyConfig = { ...config, guests: [{ username: 'legacy', password: 'guest-secret', createdAt: new Date().toISOString() }] };
  const configState = {
    load: async () => structuredClone(legacyConfig),
    save: async (next: TaiweiConfig) => { Object.assign(config, structuredClone(next)); Object.assign(legacyConfig, structuredClone(next)); },
  };
  const authFile = join(directory, 'gateway-sessions.json');
  const guestChat = new MockChat();
  let guestCurrentModel = 'free';
  const guestModelState: GatewayModelState = {
    getCurrentModel: async () => guestCurrentModel,
    resolveModels: async () => ({ models: ['good', 'free'], current: guestCurrentModel, source: 'config' }),
    setCurrentModel: async (model) => { guestCurrentModel = model; },
  };
  const server = createGatewayServer({
    chat: guestChat, auth: config.auth, configState,
    modelState: guestModelState,
    authSessions: new AuthSessionStore(authFile),
    loginLocks: new LoginLockStore(join(directory, 'login-locks.json')), log: () => {},
  });
  const port = await listenGateway(server, '127.0.0.1', 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = async (username: string, password: string) => fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  try {
    const adminLogin = await login('admin', 'admin-secret');
    const admin = await adminLogin.json() as { token: string; role: string; username: string };
    assert.equal(admin.role, 'admin');
    const adminHeaders = { authorization: `Bearer ${admin.token}` };

    assert.equal((await login('legacy', 'guest-secret')).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/guests`, { headers: adminHeaders })).status, 404);

    const badState = await fetch(`${baseUrl}/api/oauth/callback?code=valid&state=missing`);
    assert.equal(badState.status, 400);

    const oauthState = '0123456789abcdef0123456789abcdef';
    const oauthStart = await fetch(`${baseUrl}/api/oauth/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: oauthState }),
    });
    assert.equal(oauthStart.status, 200);
    const { authorizeUrl } = await oauthStart.json() as { authorizeUrl: string };
    const authorization = new URL(authorizeUrl);
    assert.equal(authorization.pathname, '/api/oauth/authorize');
    assert.equal(authorization.searchParams.get('client_id'), 'taiwei');
    assert.equal(authorization.searchParams.get('redirect_uri'), `${baseUrl}/api/oauth/callback`);
    assert.equal(authorization.searchParams.get('state'), oauthState);

    const callback = await fetch(`${baseUrl}/api/oauth/callback?code=valid&state=${oauthState}`);
    assert.equal(callback.status, 200);
    assert.match(callback.headers.get('content-type') ?? '', /^text\/html/);
    const callbackHtml = await callback.text();
    assert.match(callbackHtml, /localStorage\.setItem\('taiwei-token'/);
    assert.match(callbackHtml, /Alice\.Example/);
    const oauthToken = callbackHtml.match(/localStorage\.setItem\('taiwei-token',"([a-f0-9]{64})"\)/)?.[1];
    assert.ok(oauthToken);
    assert.match(tokenRequestBody, /client_id=taiwei/);
    assert.match(tokenRequestBody, /client_secret=taiwei-secret-2026/);
    assert.match(tokenRequestBody, /code=valid/);
    assert.equal(userinfoAuthorization, 'Bearer provider-access-token');
    const persistedSessions = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, { username: string; role: string }>;
    assert.deepEqual({ username: persistedSessions[oauthToken].username, role: persistedSessions[oauthToken].role }, { username: 'Alice.Example', role: 'guest' });
    const oauthHeaders = { authorization: `Bearer ${oauthToken}` };
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: oauthHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/memory`, { headers: oauthHeaders })).status, 403);
    // 普通用户也能查看模型目录并创建指定模型的会话（放开模型/模式选择）。
    const guestModels = await (await fetch(`${baseUrl}/api/models`, { headers: oauthHeaders })).json() as { models?: string[]; providers?: Array<{ id: string; name: string }> };
    assert.ok(guestModels.models?.length, 'guest 应能读取模型目录');
    const modelSession = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { ...oauthHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free' }),
    })).json() as { id: string; currentModel?: string };
    assert.equal(modelSession.currentModel, 'free', 'guest 建会话可指定模型');
    assert.equal((await fetch(`${baseUrl}/api/agents`, { headers: oauthHeaders })).status, 200, 'guest 应能读取 agent 模式');
    const agentSwitch = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST', headers: { ...oauthHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: modelSession.id, agentId: 'plan' }),
    });
    assert.equal(agentSwitch.status, 200, 'guest 应能切换 agent 模式（plan/build）');

    const shareResponse = await fetch(`${baseUrl}/api/share`, { method: 'POST', headers: adminHeaders });
    const share = await shareResponse.json() as { token: string };
    const shareHeaders = { authorization: `Bearer ${share.token}` };
    const shareSessionResponse = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: shareHeaders });
    assert.equal(shareSessionResponse.status, 201);
    const shareSession = await shareSessionResponse.json() as { id: string };
    assert.equal((await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { ...shareHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: shareSession.id }),
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/skills`, { headers: shareHeaders })).status, 200);
    for (const route of ['/api/tools', '/api/memory', '/api/settings']) {
      const denied = await fetch(`${baseUrl}${route}`, { headers: shareHeaders });
      assert.equal(denied.status, 403, route);
      assert.deepEqual(await denied.json(), { error: 'forbidden' });
    }

    const guestSession = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: oauthHeaders })).json() as { id: string };
    assert.equal((await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { ...oauthHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', sessionId: guestSession.id }),
    })).status, 200);
    const oauthGuestId = guestIdForUsername('Alice.Example');
    assert.ok((await stat(join(directory, 'guests', oauthGuestId, 'sessions', `${guestSession.id}.json`))).isFile());
    // Guest 会话工作目录固定为专属根（guests/<guestId>/workspace），即使会话建在自定义文件夹里也不收窄写权限边界。
    const customFolder = await (await fetch(`${baseUrl}/api/folders`, {
      method: 'POST', headers: { ...oauthHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'test' }),
    })).json() as { id: string; path?: string; dirName?: string };
    assert.equal(customFolder.path, undefined);
    assert.equal(customFolder.dirName, undefined);
    const guestRoot = join(directory, 'guests', oauthGuestId, 'workspace');
    const folderSession = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { ...oauthHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ folderId: customFolder.id }),
    })).json() as { id: string };
    assert.equal((await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { ...oauthHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi', sessionId: folderSession.id }),
    })).status, 200);
    assert.equal(guestChat.workspaceRoots.at(-1), guestRoot, 'guest 写权限边界应为专属根，而非自定义文件夹 path');

    assert.equal((await fetch(`${baseUrl}/api/share`, { method: 'DELETE', headers: adminHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/sessions`, { headers: shareHeaders })).status, 401);
  } finally {
    await closeGateway(server);
    await closeGateway(provider);
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('layered and guest memories stay isolated and extended-memory deletion rejects traversal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-layered-memory-test-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try {
    const adminMemory = new MemoryStore(join(directory, 'memory.md'));
    const guestA = MemoryStore.forGuest('guest-a');
    const guestB = MemoryStore.forGuest('guest-b');
    const registry = new ToolRegistry();
    for (const tool of createMemoryTools(adminMemory)) registry.register(tool);
    const skills = new SkillLoader();
    await registry.dispatch('memory_append', { text: 'A only' }, { cwd: directory, agentContext: new AgentContext(guestA, skills, false) });
    assert.match(await guestA.read(), /A only/);
    assert.equal(await guestB.read(), '');
    assert.equal(await adminMemory.read(), '');

    await writeExtendedMemory('project_notes', 'Extended detail');
    assert.equal(await readFile(join(directory, 'memory', 'project_notes.md'), 'utf8'), 'Extended detail');
    await assert.rejects(writeExtendedMemory('../escape', 'bad'), /name must match/);

    const server = createGatewayServer({ chat: new MockChat(), memoryDirectory: join(directory, 'memory'), log: () => {} });
    const port = await listenGateway(server, '127.0.0.1', 0);
    try {
      const traversal = await fetch(`http://127.0.0.1:${port}/api/memory/extended?name=${encodeURIComponent('../escape')}`, { method: 'DELETE' });
      assert.equal(traversal.status, 400);
      const removed = await fetch(`http://127.0.0.1:${port}/api/memory/extended?name=project_notes`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
    } finally { await closeGateway(server); }
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
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

class SlowChat implements ChatBridge {
  stopped = false;
  resolveRun: (() => void) | undefined;
  runPromise = new Promise<void>((resolve) => { this.resolveRun = resolve; });

  async run(_message: string, sink: ChatSink): Promise<void> {
    sink.event({ type: 'token', text: 'partial ' });
    await this.runPromise;
    sink.event({ type: 'token', text: 'answer' });
    sink.event({ type: 'done', text: 'partial answer' });
  }

  stop(): boolean { this.stopped = true; this.resolveRun?.(); return true; }
}

test('gateway persists reported and thrown turn errors with partial output', async (t) => {
  for (const mode of ['reported', 'thrown'] as const) {
    await t.test(mode, async () => {
      const directory = await mkdtemp(join(tmpdir(), `taiwei-gateway-${mode}-error-test-`));
      const sessions = new SessionStore(join(directory, 'sessions'));
      const chat: ChatBridge = {
        async run(_message, sink) {
          sink.event({ type: 'token', text: 'partial answer' });
          const error = new Error(`${mode} provider failure`);
          if (mode === 'thrown') throw error;
          sink.error(error);
        },
        stop: () => true,
      };
      const server = createGatewayServer({
        chat, sessions, history: false,
        uploadsDirectory: join(directory, 'uploads'),
        configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
        log: () => {},
      });
      try {
        const port = await listenGateway(server, '127.0.0.1', 0);
        const baseUrl = `http://127.0.0.1:${port}`;
        const created = await (await fetch(`${baseUrl}/api/sessions`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
        })).json() as { id: string };
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hello', sessionId: created.id }),
        });
        const events = await response.text();
        assert.match(events, new RegExp(`event: error[\\s\\S]+${mode} provider failure`));

        const session = await sessions.get(created.id);
        const assistant = session?.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant?.status, 'error');
        assert.equal(assistant?.content, `partial answer\n\n[错误] ${mode} provider failure`);
      } finally {
        await closeGateway(server);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('gateway SSE disconnect does not cancel the running turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-disconnect-test-'));
  const slowChat = new SlowChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  try {
    const server = createGatewayServer({
      chat: slowChat, sessions, history: false,
      uploadsDirectory: join(directory, 'uploads'),
      configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
      log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };
    const controller = new AbortController();
    const chatResponse = fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: created.id }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await chatResponse.catch(() => {});
    assert.equal(slowChat.stopped, false);
    slowChat.resolveRun!();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const session = await sessions.get(created.id);
    const assistantMessage = session?.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMessage);
    assert.equal(assistantMessage?.content, 'partial answer');
    assert.notEqual(assistantMessage?.status, 'pending');
    const pending = await (await fetch(`${baseUrl}/api/sessions/${created.id}/pending`)).json() as { running: boolean };
    assert.equal(pending.running, false);
    await closeGateway(server);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway pending endpoint reports running turn with partial answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-pending-test-'));
  const slowChat = new SlowChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  try {
    const server = createGatewayServer({
      chat: slowChat, sessions, history: false,
      uploadsDirectory: join(directory, 'uploads'),
      configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
      log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };
    const chatPromise = fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: created.id }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pending = await (await fetch(`${baseUrl}/api/sessions/${created.id}/pending`)).json() as {
      running: boolean; answer: string; turnId: string;
    };
    assert.equal(pending.running, true);
    assert.equal(pending.answer, 'partial ');
    assert.ok(pending.turnId);
    const sessionWhileRunning = await sessions.get(created.id);
    const pendingMsg = sessionWhileRunning?.messages.find((m) => m.role === 'assistant');
    assert.equal(pendingMsg?.status, 'pending');
    slowChat.resolveRun!();
    await chatPromise.then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterDone = await (await fetch(`${baseUrl}/api/sessions/${created.id}/pending`)).json() as { running: boolean };
    assert.equal(afterDone.running, false);
    const finalSession = await sessions.get(created.id);
    const finalAssistant = finalSession?.messages.find((m) => m.role === 'assistant');
    assert.equal(finalAssistant?.content, 'partial answer');
    assert.notEqual(finalAssistant?.status, 'pending');
    await closeGateway(server);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway explicit stop via /api/stop cancels the running turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-stop-test-'));
  const slowChat = new SlowChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  try {
    const server = createGatewayServer({
      chat: slowChat, sessions, history: false,
      uploadsDirectory: join(directory, 'uploads'),
      configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
      log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };
    const controller = new AbortController();
    const chatPromise = fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: created.id }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopResponse = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: created.id }),
    });
    const stopBody = await stopResponse.json() as { stopped: boolean };
    assert.equal(stopBody.stopped, true);
    assert.equal(slowChat.stopped, true);
    controller.abort();
    await chatPromise.catch(() => {});
    await closeGateway(server);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway session list includes running flag based on pending assistant message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-gateway-running-test-'));
  const slowChat = new SlowChat();
  const sessions = new SessionStore(join(directory, 'sessions'));
  try {
    const server = createGatewayServer({
      chat: slowChat, sessions, history: false,
      uploadsDirectory: join(directory, 'uploads'),
      configState: { load: async () => structuredClone(DEFAULT_CONFIG), save: async () => {} },
      log: () => {},
    });
    const port = await listenGateway(server, '127.0.0.1', 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };
    const chatPromise = fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: created.id }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const idle = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json() as { id: string };

    await new Promise((resolve) => setTimeout(resolve, 100));

    const listWhileRunning = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{ id: string; running?: boolean }>;
    const runningSession = listWhileRunning.find((s) => s.id === created.id);
    const idleSession = listWhileRunning.find((s) => s.id === idle.id);
    assert.equal(runningSession?.running, true);
    assert.notEqual(idleSession?.running, true);

    slowChat.resolveRun!();
    await chatPromise.then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 100));

    const listAfterDone = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{ id: string; running?: boolean }>;
    const finishedSession = listAfterDone.find((s) => s.id === created.id);
    assert.notEqual(finishedSession?.running, true);

    await closeGateway(server);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
