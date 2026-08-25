import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentContext } from '../src/agent/context.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { TaiweiApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { collectDiagnostics, DiagnosticFeedbackSession, type DiagnosticResult } from '../src/lsp/diagnostics.js';
import { MemoryStore } from '../src/memory/store.js';
import { PolicyEngine } from '../src/security/policy.js';
import { SkillLoader } from '../src/skills/loader.js';
import { diagnosticsTool } from '../src/tools/impl/diagnostics.js';
import { writeTool } from '../src/tools/impl/write.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function typescriptWorkspace(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', skipLibCheck: true }, include: ['*.ts'] }));
  return directory;
}

function context(): AgentContext { return new AgentContext(new MemoryStore(), new SkillLoader()); }

test('get_diagnostics is registered and reports a deliberate TypeScript error', async () => {
  const directory = await typescriptWorkspace('taiwei-diagnostics-tool-');
  const oldHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = join(directory, '.taiwei');
  try {
    await writeFile(join(directory, 'broken.ts'), 'const count: number = "wrong";\n');
    const direct = await collectDiagnostics(directory, { maxDiagnostics: 5 });
    assert.equal(direct.diagnostics[0]?.file, 'broken.ts');
    assert.equal(direct.diagnostics[0]?.code, 'TS2322');
    assert.match(direct.command ?? '', /--incremental --tsBuildInfoFile /);
    assert.doesNotMatch(direct.command ?? '', /--incremental false/);
    assert.deepEqual((await readdir(join(process.env.TAIWEI_HOME, 'cache', 'lsp'))).filter((name) => name.endsWith('.tsbuildinfo')).length, 1);

    const app = new TaiweiApp();
    await app.initialize({ external: false, scheduler: false });
    try { assert.equal(app.registry.get('get_diagnostics')?.name, 'get_diagnostics'); }
    finally { await app.close(); }

    const registry = new ToolRegistry();
    registry.register(diagnosticsTool);
    const result = JSON.parse(await registry.dispatch('get_diagnostics', {}, {
      cwd: directory, workspaceRoot: directory, role: 'admin', lsp: DEFAULT_CONFIG.lsp,
    })) as { diagnostics: Array<{ file: string; code: string }> };
    assert.deepEqual(result.diagnostics.map(({ file, code }) => ({ file, code })), [{ file: 'broken.ts', code: 'TS2322' }]);
  } finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('write_file refreshes diagnostics and the next model iteration receives only the new error', async () => {
  const directory = await typescriptWorkspace('taiwei-diagnostics-inject-');
  await writeFile(join(directory, 'clean.ts'), 'export const clean: number = 1;\n');
  const systemPrompts: string[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ role: string; content: string }> };
    systemPrompts.push(payload.messages[0]?.content ?? '');
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: requests === 1 ? {
      content: '', tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'broken.ts', content: 'const value: number = "bad";\n' }) } }],
    } : { content: 'I will fix the diagnostic.', tool_calls: [] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const registry = new ToolRegistry();
    registry.register(writeTool);
    registry.register(diagnosticsTool);
    const answer = await runAgentTurn('create a file', context(), registry, {
      ...structuredClone(DEFAULT_CONFIG), baseUrl: `http://127.0.0.1:${address.port}`, model: 'mock', providers: [],
    }, { cwd: directory, workspaceRoot: directory, role: 'admin', enableDiagnostics: true });
    assert.equal(answer, 'I will fix the diagnostic.');
    assert.equal(requests, 2);
    assert.doesNotMatch(systemPrompts[0]!, /Current workspace diagnostics/);
    assert.match(systemPrompts[1]!, /Current workspace diagnostics introduced/);
    assert.match(systemPrompts[1]!, /broken\.ts:1:7 - error TS2322/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('write diagnostics coalesce multiple files into one refresh', async () => {
  const workspace = '/workspace';
  let calls = 0;
  const collect = async (): Promise<DiagnosticResult> => {
    calls += 1;
    return {
      workspace,
      diagnostics: calls === 1 ? [] : [
        { file: 'one.ts', line: 1, column: 7, severity: 'error', code: 'TS2322', message: 'one', source: 'tsc' },
        { file: 'two.ts', line: 1, column: 7, severity: 'error', code: 'TS2322', message: 'two', source: 'tsc' },
      ],
      truncated: false,
    };
  };
  const session = new DiagnosticFeedbackSession(workspace, 5, undefined, collect);
  await session.beforeWrite();
  await session.afterWrite('one.ts');
  await session.afterWrite('two.ts');
  assert.equal(calls, 1, 'afterWrite must not launch the compiler');
  await session.refresh();
  assert.equal(calls, 2, 'all pending writes share one compiler refresh');
  assert.deepEqual(session.takeInjection().map((diagnostic) => diagnostic.file), ['one.ts', 'two.ts']);
  await session.refresh();
  assert.equal(calls, 2, 'refresh without new writes is a no-op');
});

test('admin diagnostics stay disabled unless the caller opts in', async () => {
  const directory = await typescriptWorkspace('taiwei-diagnostics-opt-in-');
  const oldHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = join(directory, '.taiwei');
  let requests = 0;
  const systemPrompts: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> };
    systemPrompts.push(payload.messages[0]?.content ?? '');
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: requests === 1 ? {
      content: '', tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'broken.ts', content: 'const value: number = "bad";\n' }) } }],
    } : { content: 'done', tool_calls: [] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const registry = new ToolRegistry();
    registry.register(writeTool);
    await runAgentTurn('create a file', context(), registry, {
      ...structuredClone(DEFAULT_CONFIG), baseUrl: `http://127.0.0.1:${address.port}`, model: 'mock', providers: [],
    }, { cwd: directory, workspaceRoot: directory, role: 'admin' });
    assert.equal(requests, 2);
    assert.ok(systemPrompts.every((prompt) => !prompt.includes('Current workspace diagnostics')));
    await assert.rejects(access(join(process.env.TAIWEI_HOME, 'cache', 'lsp')));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('guest turns neither expose get_diagnostics nor inject host diagnostics', async () => {
  const directory = await typescriptWorkspace('taiwei-diagnostics-guest-');
  await writeFile(join(directory, 'host-secret-error.ts'), 'const secret: number = "host";\n');
  let payload: { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof payload;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'guest answer', tool_calls: [] } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const registry = new ToolRegistry();
    registry.register(diagnosticsTool);
    assert.match(await registry.dispatch('get_diagnostics', {}, {
      cwd: directory, workspaceRoot: directory, role: 'guest', identity: 'guest', policy: new PolicyEngine(), lsp: DEFAULT_CONFIG.lsp,
    }), /denied by policy/);
    await runAgentTurn('hello', context(), registry, {
      ...structuredClone(DEFAULT_CONFIG), baseUrl: `http://127.0.0.1:${address.port}`, model: 'mock', providers: [],
    }, { cwd: directory, workspaceRoot: directory, role: 'guest', identity: 'guest', enableDiagnostics: true });
    assert.deepEqual(payload?.tools.map((tool) => tool.function.name), []);
    assert.doesNotMatch(payload?.messages[0]?.content ?? '', /host-secret-error|Current workspace diagnostics/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
