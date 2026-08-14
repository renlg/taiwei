import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fromAnthropicResponse, toAnthropicMessages } from '../src/llm/providers/anthropic.js';
import { filterToolsForModel } from '../src/llm/catalog.js';
import { loadConfig } from '../src/config/config.js';
import { AgentContext } from '../src/agent/context.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { closeGateway, createGatewayServer, listenGateway } from '../src/gateway/server.js';
import { SessionStore } from '../src/gateway/sessions.js';
import type { ChatBridge } from '../src/gateway/chat.js';
import { PluginLoader, validateManifest } from '../src/plugins/loader.js';
import { loadMcpConfig, streamableHttpOptions } from '../src/mcp/client.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseInput, renderLine, completeCommand } from '../src/tui/state.js';

async function home(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-p1-')); const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); } finally { if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous; await rm(directory, { recursive: true, force: true }); }
}

test('Anthropic adapter maps system, tool use/results, response tools, and usage', () => {
  const mapped = toAnthropicMessages([
    { role: 'system', content: 'rules' }, { role: 'user', content: 'inspect' },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'contents' },
  ]);
  assert.equal(mapped.system, 'rules'); assert.equal(mapped.messages.length, 3);
  assert.deepEqual((mapped.messages[1]!.content as unknown as Array<Record<string, unknown>>)[1], { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'a' } });
  assert.deepEqual((mapped.messages[2]!.content as unknown as Array<Record<string, unknown>>)[0], { type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' });
  const result = fromAnthropicResponse({ model: 'claude-fixture', content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id: '2', name: 'bash', input: { command: 'pwd' } }], usage: { input_tokens: 9, output_tokens: 4 } });
  assert.equal(result.content, 'done'); assert.equal(result.toolCalls[0]?.function.name, 'bash'); assert.deepEqual(result.usage, { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
});

test('capability filtering removes tool definitions for a no-tools model', async () => {
  assert.deepEqual(filterToolsForModel([1, 2], { capabilities: { tools: false, vision: false, reasoning: false, streaming: true, contextWindow: 1000 } }), []);
  let requestBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requestBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  try {
    const config = structuredClone(DEFAULT_CONFIG); config.providers = [{ id: 'plain', name: 'Plain', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: 'text-only', models: [{ id: 'text-only', provider: 'plain', displayName: 'Text', capabilities: { tools: false, vision: false, reasoning: false, streaming: true, contextWindow: 10_000 } }] }]; config.defaultProvider = 'plain'; config.model = 'text-only';
    const registry = new ToolRegistry(); registry.register({ name: 'demo', description: 'demo', parameters: { type: 'object' }, execute: () => 'x' });
    await runAgentTurn('hello', new AgentContext(new MemoryStore(), new SkillLoader()), registry, config, { providerId: 'plain', model: 'text-only' });
    assert.deepEqual(requestBody.tools, []);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('legacy apiBaseUrl config maps to a synthetic default provider', async () => home(async (directory) => {
  await writeFile(join(directory, 'config.json'), JSON.stringify({ apiBaseUrl: 'http://legacy.test/v1', apiKey: 'legacy-key', model: 'legacy-model' }));
  const config = await loadConfig(); assert.equal(config.baseUrl, 'http://legacy.test/v1'); assert.equal(config.providers[0]?.baseUrl, 'http://legacy.test/v1'); assert.equal(config.providers[0]?.defaultModel, 'legacy-model');
}));

test('gateway model overrides remain isolated per session', async () => home(async (directory) => {
  const sessions = new SessionStore(join(directory, 'sessions')); const first = await sessions.create(); const second = await sessions.create();
  const chat: ChatBridge = { run: async () => {}, stop: () => false };
  const models = { getCurrentModel: async () => 'a', setCurrentModel: async () => {}, resolveModels: async () => ({ models: ['a', 'b'], current: 'a', source: 'config' as const, currentProvider: 'p', providers: [{ id: 'p', name: 'Provider', models: ['a', 'b'].map((id) => ({ id, provider: 'p', displayName: id, capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 1000 } })) }] }) };
  const server = createGatewayServer({ chat, sessions, modelState: models, log: () => {} }); const port = await listenGateway(server, '127.0.0.1', 0);
  try {
    const changed = await fetch(`http://127.0.0.1:${port}/api/model`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: first.id, provider: 'p', model: 'b' }) }); assert.equal(changed.status, 200);
    assert.equal((await sessions.get(first.id))?.currentModel, 'b'); assert.equal((await sessions.get(second.id))?.currentModel, undefined);
  } finally { await closeGateway(server); }
}));

test('Plugin API validates manifests, disposes on disable, contains crashes, and persists enable state', async () => home(async (directory) => {
  assert.throws(() => validateManifest({ name: 'bad', version: '1', apiVersion: 2, capabilities: [], main: 'index.js' }), /unsupported apiVersion/);
  const bad = join(directory, 'plugins', 'bad'); await mkdir(bad, { recursive: true }); await writeFile(join(bad, 'manifest.json'), JSON.stringify({ name: 'bad', version: '1', apiVersion: 2, capabilities: [], main: 'index.js' }));
  const demo = join(directory, 'plugins', 'demo'); await mkdir(demo, { recursive: true });
  await writeFile(join(demo, 'manifest.json'), JSON.stringify({ name: 'demo', version: '1.0.0', apiVersion: 1, capabilities: ['tools'], main: 'index.js' }));
  await writeFile(join(demo, 'index.js'), `import { writeFile } from 'node:fs/promises'; export default { init(api) { api.registerTool({name:'boom',description:'boom',parameters:{type:'object'}}, () => { throw new Error('kaboom') }) }, dispose() { return writeFile(${JSON.stringify(join(directory, 'disposed'))}, 'yes') } }`);
  const registry = new ToolRegistry(); const loader = new PluginLoader(registry); await loader.reload();
  assert.match(loader.list().find((item) => item.name === 'bad')?.error ?? '', /apiVersion/);
  assert.match(await registry.dispatch('plugin_demo_boom', {}, { cwd: directory }), /kaboom/);
  assert.match(await registry.dispatch('plugin_demo_boom', {}, { cwd: directory }), /unavailable/);
  await loader.setEnabled('demo', false); assert.equal(await readFile(join(directory, 'disposed'), 'utf8'), 'yes');
  const stored = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { plugins?: Record<string, { enabled?: boolean }> }; assert.equal(stored.plugins?.demo?.enabled, false);
}));

test('MCP streamable HTTP config and request headers are accepted', async () => home(async (directory) => {
  const path = join(directory, 'mcp.json'); await writeFile(path, JSON.stringify([{ name: 'remote', transport: 'streamable-http', url: 'https://mcp.test/rpc', headers: { Authorization: 'Bearer secret' }, enabled: true }]));
  const config = (await loadMcpConfig(path))[0]!; assert.equal(config.transport, 'streamable-http');
  const options = streamableHttpOptions(config); const headers = options?.requestInit?.headers as Record<string, string>;
  assert.equal(headers.accept, 'application/json, text/event-stream'); assert.equal(headers.Authorization, 'Bearer secret');
  let captured: { url?: string; init?: RequestInit } = {};
  const transport = new StreamableHTTPClientTransport(new URL(config.url!), { ...options, fetch: async (url, init) => { captured = { url: String(url), init }; return new Response(null, { status: 202 }); } });
  await transport.start(); await transport.send({ jsonrpc: '2.0', method: 'notifications/test' }); await transport.close();
  assert.equal(captured.url, 'https://mcp.test/rpc'); assert.equal(captured.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured.init?.body)), { jsonrpc: '2.0', method: 'notifications/test' });
  assert.equal(new Headers(captured.init?.headers).get('accept'), 'application/json, text/event-stream');
}));

test('TUI pure input and rendering state helpers handle commands, quoting, completion, and truncation', () => {
  assert.deepEqual(parseInput(' hello '), { kind: 'message', text: 'hello' });
  assert.deepEqual(parseInput('/export "my session.json"'), { kind: 'command', command: '/export', args: ['my session.json'] });
  assert.equal(completeCommand('/res'), '/resume '); assert.equal(renderLine('abcdef', 4), 'abc…'); assert.equal(renderLine('a', 3), 'a  ');
});
