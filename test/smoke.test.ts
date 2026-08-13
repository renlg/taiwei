import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { nextRun, parseInterval } from '../src/cron/scheduler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { streamChat } from '../src/llm/client.js';
import { PluginLoader } from '../src/plugins/loader.js';
import { chunkText } from '../src/rag/index.js';

test('config initializes with defaults and honors environment overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  const oldModel = process.env.TAIWEI_MODEL;
  process.env.TAIWEI_HOME = directory;
  process.env.TAIWEI_MODEL = 'test-model';
  try {
    const config = await loadConfig();
    assert.equal(config.model, 'test-model');
    assert.equal(config.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.maxTurns, 50);
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
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"memory_","arguments":"{\\"te"}}]}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"append","arguments":"xt\\":\\"note\\"}"}}]}}]}\n\n');
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
