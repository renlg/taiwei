import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentContext } from '../src/agent/context.js';
import { DelegationManager } from '../src/agent/delegation.js';
import { getAgentProfile, getAgentProfiles, narrowProfile, toolDenied } from '../src/agents/profiles.js';
import { reloadUserAgents } from '../src/agents/user-agents.js';
import { MemoryStore } from '../src/memory/store.js';
import { SkillLoader } from '../src/skills/loader.js';
import { PolicyEngine } from '../src/security/policy.js';
import { createDelegateTool } from '../src/tools/impl/delegate.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { getPaths } from '../src/util/paths.js';

const definitions = {
  agents: [
    { name: 'frontend', mode: 'build', systemPrompt: '你是前端专家...', model: 'gpt-5.6-sol', tools: ['search_files', 'read_file', 'write_file', 'bash'], maxTurns: 30 },
    { name: 'reviewer', mode: 'plan', systemPrompt: '只做代码评审，不改文件', tools: ['read_file', 'search_files'], model: 'claude-sonnet' },
  ],
};

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'taiwei-user-agents-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = home;
  try { await run(home); }
  finally {
    if (previous === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeAgents(value: unknown): Promise<void> {
  await writeFile(getPaths().agentsFile, `${JSON.stringify(value)}\n`, 'utf8');
  reloadUserAgents();
}

test('loads user agents through TAIWEI_HOME while preserving built-ins', async () => withHome(async () => {
  await writeAgents(definitions);
  const frontend = getAgentProfile('frontend');
  assert.deepEqual(frontend, {
    id: 'frontend', mode: 'build', prompt: '你是前端专家...', model: 'gpt-5.6-sol', maxTurns: 30,
    toolPolicy: { allow: ['search_files', 'read_file', 'write_file', 'bash'] },
  });
  assert.equal(getAgentProfile('build').prompt, 'Build mode: implement and verify requested changes using the available tools.');
  assert.deepEqual(getAgentProfiles().map(({ id }) => id), ['plan', 'build', 'research', 'frontend', 'reviewer']);
}));

test('delegate_task accepts a custom agent name and applies its tool allow list', async () => withHome(async (home) => {
  await writeAgents(definitions);
  let childProfile: ReturnType<typeof getAgentProfile> | undefined;
  const manager = new DelegationManager(async (request) => { childProfile = request.profile; return 'frontend done'; });
  const registry = new ToolRegistry();
  registry.register(createDelegateTool(manager));
  registry.configure({ delegate_task: { allowedAgents: 'research,frontend' } });
  const memory = new MemoryStore(join(home, 'memory.md'));
  const parent = getAgentProfile('build');
  const output = JSON.parse(await registry.dispatch('delegate_task', { task: 'build the UI', agent: 'frontend' }, {
    cwd: home, workspaceRoot: home, role: 'admin', identity: 'admin', sessionId: 'parent',
    agentContext: new AgentContext(memory, new SkillLoader(), true, parent), agentProfile: parent,
  })) as { result: string };
  assert.equal(output.result, 'frontend done');
  assert.equal(childProfile?.id, 'frontend');
  assert.equal(childProfile?.model, 'gpt-5.6-sol');
  assert.equal(toolDenied('write_file', childProfile), false);
  assert.equal(toolDenied('memory_append', childProfile), true);
}));

test('custom child permissions are narrowed by the parent allow list', async () => withHome(async () => {
  await writeAgents(definitions);
  const parent = { ...getAgentProfile('build'), id: 'restricted-parent', toolPolicy: { allow: ['read_file', 'search_files'] } };
  const narrowed = narrowProfile(parent, getAgentProfile('frontend'));
  assert.deepEqual(narrowed.toolPolicy?.allow, ['read_file', 'search_files']);
  assert.equal(toolDenied('write_file', narrowed), true);
  assert.equal(toolDenied('read_file', narrowed), false);
  const wildcard = narrowProfile(
    { ...parent, toolPolicy: { allow: ['mcp_*'] } },
    { ...getAgentProfile('frontend'), toolPolicy: { allow: ['mcp_read_*'] } },
  );
  assert.deepEqual(wildcard.toolPolicy?.allow, ['mcp_read_*']);
  assert.equal(toolDenied('mcp_write_file', wildcard), true);
}));

test('invalid agents JSON reports a clear error and falls back to built-ins', async () => withHome(async () => {
  await writeFile(getPaths().agentsFile, '{not json', 'utf8');
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  try { assert.deepEqual(reloadUserAgents(), []); }
  finally { console.error = original; }
  assert.equal(getAgentProfile('build').id, 'build');
  assert.throws(() => getAgentProfile('frontend'), /Unknown agent profile/);
  assert.match(messages.join('\n'), /Failed to load user agents.*agents\.json.*Falling back to built-in agents only/);
}));

test('agent names conflicting with built-ins are rejected as a whole', async () => withHome(async () => {
  await writeFile(getPaths().agentsFile, JSON.stringify({ agents: [{ name: 'build', mode: 'build', systemPrompt: 'override' }] }), 'utf8');
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  try { assert.deepEqual(reloadUserAgents(), []); }
  finally { console.error = original; }
  assert.equal(getAgentProfile('build').prompt, 'Build mode: implement and verify requested changes using the available tools.');
  assert.match(messages.join('\n'), /agent name "build" conflicts/);
}));

test('guest policy still blocks delegation before a custom agent can run', async () => withHome(async (home) => {
  await writeAgents(definitions);
  let called = false;
  const registry = new ToolRegistry();
  registry.register(createDelegateTool(new DelegationManager(async () => { called = true; return 'unsafe'; })));
  registry.configure({ delegate_task: { allowedAgents: 'frontend' } });
  const parent = getAgentProfile('build');
  const output = await registry.dispatch('delegate_task', { task: 'escape', agentId: 'frontend' }, {
    cwd: home, workspaceRoot: home, role: 'guest', identity: 'guest-test', sessionId: 'guest',
    agentContext: new AgentContext(new MemoryStore(join(home, 'guest-memory.md')), new SkillLoader(), false, parent),
    agentProfile: parent, policy: new PolicyEngine(),
  });
  assert.match(output, /builtin\.guest\.no-delegation/);
  assert.equal(called, false);
}));
