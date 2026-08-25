import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentContext } from '../src/agent/context.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { UserSkillStore } from '../src/skills/user-store.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await readFile(path, 'utf8'); }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('skill self-learning is opt-in by default', () => {
  assert.equal(DEFAULT_CONFIG.skillSelfLearning, false);
});

test('successful turns emit done before asynchronously distilling with the injected store and guest id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-self-learning-'));
  const previousHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  const models: string[] = [];
  const timeline: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: Array<{ content: string }> };
    models.push(body.model);
    const distilling = body.messages[0]?.content.includes('reusable multi-step workflow');
    if (distilling) timeline.push('distill-request');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: distilling
      ? '---\nname: deploy-demo\ndescription: Deploy the demo with verification\n---\n\n1. Build.\n2. Deploy.\n3. Verify.\n'
      : 'Task complete', tool_calls: [] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const config = structuredClone(DEFAULT_CONFIG);
    config.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.model = 'expensive-model';
    config.skillSelfLearning = true;
    config.skillSelfLearningModel = 'cheap-model';
    const owner = 'guest-share-0123456789abcdef01234567';
    const skillsRoot = join(directory, 'injected-user-skills');
    const answer = await runAgentTurn('Deploy the demo using several verified steps.', new AgentContext(new MemoryStore(), new SkillLoader()), new ToolRegistry(), config, {
      role: 'guest', identity: '访客', guestId: owner, retainConversation: false,
      userSkillStore: new UserSkillStore(skillsRoot),
      onEvent: (event) => { if (event.type === 'done') timeline.push('done'); },
    });
    assert.equal(answer, 'Task complete');
    assert.match(await waitForFile(join(skillsRoot, owner, 'deploy-demo', 'SKILL.md')), /Deploy the demo with verification/);
    assert.deepEqual(models, ['expensive-model', 'cheap-model']);
    assert.deepEqual(timeline, ['done', 'distill-request']);
  } finally {
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
