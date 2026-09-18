import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLARIFICATION_END,
  CLARIFICATION_START,
  ClarificationStreamGate,
  parseClarification,
} from '../src/agent/clarification.js';
import { AgentContext } from '../src/agent/context.js';
import { runAgentTurn, type AgentEvent } from '../src/agent/loop.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { ToolRegistry } from '../src/tools/registry.js';

const payload = `${CLARIFICATION_START}\n{"questions":[{"question":"部署到哪里？","options":["测试环境","生产环境"],"allowCustom":true},{"question":"何时执行？","options":["现在","今晚"],"allowCustom":true}]}\n${CLARIFICATION_END}`;
const wrapClarification = (content: string): string => `${CLARIFICATION_START}\n${content}\n${CLARIFICATION_END}`;

test('clarification parser validates questions and strips its marker block', () => {
  assert.deepEqual(parseClarification(`请确认\n${payload}\n谢谢`), {
    payload: { questions: [
      { question: '部署到哪里？', options: ['测试环境', '生产环境'], allowCustom: true },
      { question: '何时执行？', options: ['现在', '今晚'], allowCustom: true },
    ] },
    cleanedText: '请确认\n\n谢谢',
  });
  assert.equal(parseClarification(`${CLARIFICATION_START}\n{"questions":[]}\n${CLARIFICATION_END}`), undefined);

  const gate = new ClarificationStreamGate();
  assert.equal(gate.push('<<<TAIWEI_'), '');
  assert.equal(gate.push('CLARIFICATION>>>\n{'), '');
  assert.equal(gate.finish(true), '');
  const normal = new ClarificationStreamGate();
  assert.equal(normal.push('正常回答'), '正常回答');
});

test('clarification parser repairs a missing trailing object brace', () => {
  const truncated = wrapClarification('{"questions":[{"question":"Where?","options":["A","B"],"allowCustom":true}]');
  assert.equal(parseClarification(truncated)?.payload.questions.length, 1);
});

test('clarification parser repairs missing trailing array and object braces', () => {
  const truncated = wrapClarification('{"questions":[{"question":"Where?","options":["A","B"],"allowCustom":true}');
  assert.equal(parseClarification(truncated)?.payload.questions.length, 1);
});

test('clarification parser repairs a dangling trailing quote', () => {
  const truncated = wrapClarification('{"questions":[{"question":"Where?","options":["A","B"],"allowCustom":true}"');
  assert.equal(parseClarification(truncated)?.payload.questions.length, 1);
});

test('clarification parser rejects malformed content during repair', () => {
  const malformed = wrapClarification('{"questions":[{"question":"Where?",garbage,"options":["A","B"],"allowCustom":true}]');
  assert.equal(parseClarification(malformed), undefined);
});

test('agent emits clarification and discards simultaneous tool calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-clarification-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  let executed = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: {
      content: payload,
      tool_calls: [{ id: 'unsafe', type: 'function', function: { name: 'danger', arguments: '{}' } }],
    } }] }));
  });
  const baseUrl = await listen(server);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.baseUrl = baseUrl;
    config.skillSelfLearning = false;
    config.retry = { ...config.retry, maxAttempts: 1 };
    const registry = new ToolRegistry();
    registry.register({ name: 'danger', description: 'must not run', parameters: { type: 'object' }, execute: () => { executed = true; return 'ran'; } });
    const context = new AgentContext(new MemoryStore(), new SkillLoader());
    const events: AgentEvent[] = [];
    const result = await runAgentTurn('帮我部署', context, registry, config, { onEvent: (event) => events.push(event) });
    assert.equal(result, '请回答以下澄清问题。');
    assert.equal(executed, false);
    assert.equal(events.some((event) => event.type === 'token'), false);
    assert.equal(events.filter((event) => event.type === 'clarification').length, 1);
    assert.deepEqual(events.at(-1), { type: 'done', text: '请回答以下澄清问题。' });
    const assistant = context.messages.at(-1);
    assert.equal(assistant?.role, 'assistant');
    assert.equal(assistant?.role === 'assistant' ? assistant.tool_calls : undefined, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server port');
  return `http://127.0.0.1:${address.port}/v1`;
}
