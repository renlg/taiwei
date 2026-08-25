import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentContext } from '../src/agent/context.js';
import { runAgentTurn, type AgentEvent } from '../src/agent/loop.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { repairToolCallArguments, type ChatMessage } from '../src/llm/client.js';

test('repairToolCallArguments conservatively repairs common malformed JSON', () => {
  assert.equal(repairToolCallArguments('{"name": "ls"'), '{"name": "ls"}');
  assert.equal(repairToolCallArguments('{name: "ls"}'), '{"name": "ls"}');
  assert.equal(repairToolCallArguments('{"name":"ls",}'), '{"name":"ls"}');
  assert.equal(repairToolCallArguments('```json\n{"name":"ls"}\n```'), '{"name":"ls"}');
  assert.equal(repairToolCallArguments('{"name": ]'), null);
});

test('unrepairable tool arguments produce regeneration feedback without poisoning upstream history', async () => isolated(async () => {
  const requests: Array<{ messages: ChatMessage[] }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof requests[number]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests.length === 1
      ? { choices: [{ message: { content: null, tool_calls: [{ id: 'bad-call', type: 'function', function: { name: 'bash', arguments: '{"command": ]' } }] } }] }
      : { choices: [{ message: { content: 'recovered', tool_calls: [] } }] }));
  });
  const baseUrl = await listen(server);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.baseUrl = baseUrl;
    config.retry = { ...config.retry, maxAttempts: 1 };
    assert.equal(await runAgentTurn('hello', context(), new ToolRegistry(), config), 'recovered');
    const assistant = requests[1]?.messages.find((message) => message.role === 'assistant' && message.tool_calls?.length);
    const tool = requests[1]?.messages.find((message) => message.role === 'tool');
    assert.equal(assistant?.role === 'assistant' ? assistant.tool_calls?.[0]?.function.arguments : undefined, '{}');
    assert.match(tool?.content ?? '', /please regenerate with valid JSON/);
  } finally { await close(server); }
}));

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-llm-feedback-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); }
  finally {
    if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server port');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function context(): AgentContext {
  return new AgentContext(new MemoryStore(), new SkillLoader());
}

test('an unretryable 400 is fed back into the next model iteration', async () => isolated(async (directory) => {
  const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof requests[number]);
    response.writeHead(requests.length === 1 ? 400 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests.length === 1
      ? { error: { message: 'invalid upstream payload' } }
      : { choices: [{ message: { content: 'recovered', tool_calls: [] } }] }));
  });
  const baseUrl = await listen(server);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.baseUrl = baseUrl;
    config.model = 'feedback-model';
    config.retry = { ...config.retry, maxAttempts: 1, maxFeedbackIterations: 2 };
    const agentContext = context();
    const events: AgentEvent[] = [];
    assert.equal(await runAgentTurn('hello', agentContext, new ToolRegistry(), config, {
      onEvent: (event) => events.push(event),
    }), 'recovered');
    assert.equal(requests.length, 2);
    const injected = requests[1]?.messages.at(-1);
    assert.equal(injected?.role, 'user');
    assert.deepEqual(JSON.parse(injected?.content ?? '{}'), {
      type: 'llm_request_error',
      model: 'feedback-model',
      message: 'Provider request failed (400): invalid upstream payload',
      status: 400,
      feedbackAttempt: 1,
      maxFeedbackIterations: 2,
      instruction: 'The previous upstream LLM request failed after provider retry/fallback handling. Use this feedback to choose the next step or explain the failure to the user.',
    });
    assert.equal(events.filter((event) => event.type === 'model_iterate').length, 1);
    assert.match(await readFile(join(directory, 'audit.jsonl'), 'utf8'), /"type":"model.iterate"/);
  } finally { await close(server); }
}));

test('model feedback iteration stops after the configured safety limit', async () => isolated(async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    calls += 1;
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `failure ${calls}` } }));
  });
  const baseUrl = await listen(server);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.baseUrl = baseUrl;
    config.retry = { ...config.retry, maxAttempts: 1, maxFeedbackIterations: 2 };
    const events: AgentEvent[] = [];
    await assert.rejects(runAgentTurn('hello', context(), new ToolRegistry(), config, {
      onEvent: (event) => events.push(event),
    }), /failure 3/);
    assert.equal(calls, 3);
    assert.equal(events.filter((event) => event.type === 'model_iterate').length, 2);
  } finally { await close(server); }
}));

test('AbortError bypasses model feedback iteration', async () => isolated(async () => {
  let calls = 0;
  const controller = new AbortController();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    calls += 1;
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    response.destroy();
  });
  const baseUrl = await listen(server);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.baseUrl = baseUrl;
    config.retry = { ...config.retry, maxAttempts: 1, maxFeedbackIterations: 2 };
    const events: AgentEvent[] = [];
    await assert.rejects(runAgentTurn('hello', context(), new ToolRegistry(), config, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(calls, 1);
    assert.equal(events.filter((event) => event.type === 'model_iterate').length, 0);
  } finally { await close(server); }
}));
