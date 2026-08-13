import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, validateGatewayAuth } from '../src/config/config.js';
import { nextRun, parseInterval } from '../src/cron/scheduler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { streamChat } from '../src/llm/client.js';
import { PluginLoader } from '../src/plugins/loader.js';
import { chunkText } from '../src/rag/index.js';
import { getCurrentModel, resolveModels, setCurrentModel } from '../src/config/model.js';
import { handleModelCommand } from '../src/cli/repl.js';
import type { TaiweiApp } from '../src/app.js';

test('config initializes with defaults and honors environment overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  const oldModel = process.env.TAIWEI_MODEL;
  const oldAuthPassword = process.env.TAIWEI_AUTH_PASSWORD;
  process.env.TAIWEI_HOME = directory;
  process.env.TAIWEI_MODEL = 'test-model';
  process.env.TAIWEI_AUTH_PASSWORD = 'environment-secret';
  try {
    const config = await loadConfig();
    assert.equal(config.model, 'test-model');
    assert.equal(config.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.contextWindow, 128_000);
    assert.equal(config.maxTurns, 50);
    assert.equal(config.auth.enabled, false);
    assert.equal(config.auth.username, 'admin');
    assert.equal(config.auth.password, 'environment-secret');
  } finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    if (oldModel === undefined) delete process.env.TAIWEI_MODEL; else process.env.TAIWEI_MODEL = oldModel;
    if (oldAuthPassword === undefined) delete process.env.TAIWEI_AUTH_PASSWORD; else process.env.TAIWEI_AUTH_PASSWORD = oldAuthPassword;
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway auth validation rejects an enabled empty password', () => {
  assert.throws(() => validateGatewayAuth({
    model: 'test', baseUrl: 'http://localhost', apiKey: '', maxTurns: 1, requestTimeoutMs: 1,
    gateway: { host: '127.0.0.1', port: 0 },
    auth: { enabled: true, username: 'admin', password: '' },
  }), /auth\.password.*TAIWEI_AUTH_PASSWORD/);
});

test('model state falls back when upstream is unavailable and persists switches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-model-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  const oldModel = process.env.TAIWEI_MODEL;
  process.env.TAIWEI_HOME = directory;
  delete process.env.TAIWEI_MODEL;
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ model: 'good', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'secret' }));
    assert.deepEqual(await resolveModels(), { models: ['good'], current: 'good', source: 'fallback' });
    await setCurrentModel('free');
    assert.equal(await getCurrentModel(), 'free');
    const stored = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { model: string; baseUrl: string };
    assert.equal(stored.model, 'free');
    assert.equal(stored.baseUrl, 'http://127.0.0.1:1/v1');
  } finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    if (oldModel === undefined) delete process.env.TAIWEI_MODEL; else process.env.TAIWEI_MODEL = oldModel;
    await rm(directory, { recursive: true, force: true });
  }
});

test('REPL model command lists candidates, switches, and rejects unknown names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-repl-model-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  const oldModel = process.env.TAIWEI_MODEL;
  process.env.TAIWEI_HOME = directory;
  delete process.env.TAIWEI_MODEL;
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ model: 'good', models: ['good', 'free'] }));
    const app = { config: await loadConfig() } as TaiweiApp;
    assert.equal(await handleModelCommand(app), 'Current model: good\nAvailable models:\n* good\n  free');
    assert.equal(await handleModelCommand(app, 'free'), '[taiwei] Model set to free.');
    assert.equal((JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { model: string }).model, 'free');
    await assert.rejects(handleModelCommand(app, 'missing'), /Unknown model: missing.*Available models/s);
  } finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    if (oldModel === undefined) delete process.env.TAIWEI_MODEL; else process.env.TAIWEI_MODEL = oldModel;
    await rm(directory, { recursive: true, force: true });
  }
});

test('tool registry dispatches registered tools and reports unknown tools', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'add', description: 'add numbers',
    parameters: { type: 'object' },
    execute: (args) => Number(args.a) + Number(args.b),
  });
  assert.equal(await registry.dispatch('add', { a: 2, b: 3 }, { cwd: process.cwd() }), '5');
  assert.match(await registry.dispatch('missing', {}, { cwd: process.cwd() }), /Unknown tool/);
});

test('cron schedule parser handles intervals and cron expressions', () => {
  assert.equal(parseInterval('30s'), 30_000);
  assert.equal(parseInterval('every 1h'), 3_600_000);
  const now = new Date('2026-01-01T00:00:00Z');
  assert.equal(nextRun('*/5 * * * *', now).toISOString(), '2026-01-01T00:05:00.000Z');
  assert.throws(() => nextRun('not a schedule', now), /Invalid schedule/);
});

test('LLM client assembles streamed text and fragmented tool calls', async () => {
  let requestPayload: { stream_options?: { include_usage?: boolean } } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestPayload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof requestPayload;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"memory_","arguments":"{\\"te"}}]}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"append","arguments":"xt\\":\\"note\\"}"}}]}}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    let streamed = '';
    const result = await streamChat({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: '', model: 'test', messages: [{ role: 'user', content: 'hello' }], tools: [],
      onText: (text) => { streamed += text; },
    });
    assert.equal(streamed, 'Hello world');
    assert.equal(result.content, 'Hello world');
    assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 3, totalTokens: 14 });
    assert.deepEqual(requestPayload.stream_options, { include_usage: true });
    assert.deepEqual(result.toolCalls[0], { id: 'call_1', type: 'function', function: { name: 'memory_append', arguments: '{"text":"note"}' } });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('plugin loader supports CommonJS and ESM plugin.js files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-plugin-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try {
    await mkdir(join(directory, 'plugins', 'common'), { recursive: true });
    await mkdir(join(directory, 'plugins', 'module'), { recursive: true });
    await writeFile(join(directory, 'plugins', 'common', 'plugin.js'), `module.exports = { name: 'common', tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object' }, execute: () => 'pong' }] };`);
    await writeFile(join(directory, 'plugins', 'module', 'plugin.js'), `export default { name: 'module', skills: [{ name: 'mod-skill', description: 'module skill', body: 'Be modular.' }] };`);
    const registry = new ToolRegistry();
    const loader = new PluginLoader(registry);
    await loader.reload();
    assert.equal(await registry.dispatch('plugin_common_ping', {}, { cwd: directory }), 'pong');
    assert.equal(loader.skills()[0]?.name, 'mod-skill');
    assert.equal(loader.list().filter((item) => !item.error).length, 2);
    await writeFile(join(directory, 'plugins', 'common', 'plugin.js'), `module.exports = { name: 'common', tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object' }, execute: () => 'fresh' }] };`);
    await loader.reload();
    assert.equal(await registry.dispatch('plugin_common_ping', {}, { cwd: directory }), 'fresh');
  } finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('RAG chunker bounds oversized paragraphs and preserves overlap', () => {
  const chunks = chunkText('a'.repeat(2_200), 1_000, 100);
  assert.equal(chunks.length, 3);
  assert(chunks.every((chunk) => chunk.length <= 1_000));
  assert.equal(chunks[0].slice(-100), chunks[1].slice(0, 100));
});
