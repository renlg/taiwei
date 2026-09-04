import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LSP_SERVERS, LspManager, LspServerNotFoundError } from '../src/lsp/client.js';
import { createLspTools } from '../src/tools/impl/lsp.js';
import type { ToolContext } from '../src/tools/registry.js';
import { PolicyEngine } from '../src/security/policy.js';
import { getAgentProfile, toolDenied } from '../src/agents/profiles.js';

test('DEFAULT_LSP_SERVERS covers TypeScript, Python, Go, Rust, and C/C++', () => {
  const extensions = DEFAULT_LSP_SERVERS.flatMap((server) => server.extensions);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.c', '.cpp', '.h']) {
    assert.ok(extensions.includes(ext), `missing extension ${ext}`);
  }
  assert.ok(DEFAULT_LSP_SERVERS.every((server) => typeof server.command === 'string' && server.command.length > 0));
});

test('LspManager.serverForFile matches extensions case-insensitively', () => {
  const manager = new LspManager(DEFAULT_LSP_SERVERS);
  const tsServer = manager.serverForFile('src/index.ts');
  assert.ok(tsServer);
  assert.ok(tsServer.extensions.includes('.ts'));
  assert.equal(manager.serverForFile('readme.md'), undefined);
  assert.equal(manager.serverForFile('no-ext'), undefined);
  // Case-insensitive: .TS should still match.
  const tsxServer = manager.serverForFile('Component.TSX');
  assert.ok(tsxServer);
});

test('LspManager closes safely and replaces a client after its server exits', async () => {
  const manager = new LspManager([]);
  await manager.close(); // Should not throw.

  const directory = await mkdtemp(join(tmpdir(), 'taiwei-lsp-restart-test-'));
  const serverScript = join(directory, 'server.mjs');
  const spawnCount = join(directory, 'spawn-count.txt');
  await writeFile(serverScript, `
import { readFileSync, writeFileSync } from 'node:fs';
const countFile = process.argv[2];
let count = 0;
try { count = Number(readFileSync(countFile, 'utf8')); } catch {}
writeFileSync(countFile, String(count + 1));
let buffer = Buffer.alloc(0);
function send(id, result) {
  const json = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const match = /content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.method === 'initialize') send(message.id, { capabilities: {} });
    if (message.method === 'textDocument/documentSymbol') {
      send(message.id, []);
      setImmediate(() => process.exit(0));
    }
  }
});
`, 'utf8');
  const restartManager = new LspManager([{ command: process.execPath, args: [serverScript, spawnCount], extensions: ['.xyz'] }]);
  try {
    await restartManager.documentSymbols(directory, join(directory, 'test.xyz'), 'first');
    const clients = (restartManager as unknown as { clients: Map<string, unknown> }).clients;
    for (let attempt = 0; attempt < 50 && clients.size !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(clients.size, 0, 'exited LSP client should be evicted immediately');
    await restartManager.documentSymbols(directory, join(directory, 'test.xyz'), 'second');
    assert.equal(await readFile(spawnCount, 'utf8'), '2');
  } finally {
    await restartManager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('LSP tools return guest-disabled message for guest role', async () => {
  const manager = new LspManager([]);
  const tools = createLspTools(manager);
  const context: ToolContext = { cwd: '/tmp', role: 'guest' };
  for (const tool of tools) {
    const result = await tool.execute({ filePath: 'test.ts' }, context);
    assert.deepEqual(result, { error: 'Semantic navigation is unavailable for guest sessions' });
  }
});

test('LSP tools return disabled message when lsp.enabled is false', async () => {
  const manager = new LspManager([]);
  const tools = createLspTools(manager);
  const context: ToolContext = { cwd: '/tmp', lsp: { enabled: false, maxDiagnostics: 5, autoInject: true, servers: [] } };
  for (const tool of tools) {
    const result = await tool.execute({ filePath: 'test.ts' }, context);
    assert.deepEqual(result, { error: 'LSP is disabled in config (lsp.enabled=false)' });
  }
});

test('LSP tools return actionable error when language server binary is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-lsp-missing-test-'));
  try {
    await writeFile(join(directory, 'test.xyz'), 'some content\n');
    const manager = new LspManager([{ command: 'nonexistent-langserver-xyz', extensions: ['.xyz'] }]);
    const tools = createLspTools(manager);
    const context: ToolContext = { cwd: directory };
    const result = await tools[0]!.execute({ filePath: 'test.xyz', line: 1 }, context);
    assert.ok(typeof result === 'object' && result !== null && 'error' in result);
    assert.match(String((result as { error: string }).error), /nonexistent-langserver-xyz/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('LspServerNotFoundError carries the missing command name', () => {
  const error = new LspServerNotFoundError('missing-binary');
  assert.ok(error instanceof Error);
  assert.match(error.message, /missing-binary/);
});

test('plan and research allow only the documented read-only LSP navigation tools', () => {
  const policy = new PolicyEngine();
  const decide = (tool: string) => policy.decide({
    role: 'admin', agentMode: 'plan', sessionId: 'plan', tool, args: {}, cwd: '/tmp', workspaceRoot: '/tmp', identity: 'admin',
  });
  for (const tool of ['document_symbols', 'go_to_definition', 'find_references']) {
    assert.equal(decide(tool).effect, 'allow');
    assert.equal(toolDenied(tool, getAgentProfile('research')), false);
  }
  assert.equal(decide('lsp_apply_workspace_edit').effect, 'deny');
  assert.equal(toolDenied('lsp_apply_workspace_edit', getAgentProfile('plan')), true);
  assert.equal(toolDenied('lsp_apply_workspace_edit', getAgentProfile('research')), true);
  const explicitAllowPolicy = new PolicyEngine({ rules: [{ match: { agentMode: 'plan', tool: 'lsp_*' }, effect: 'allow' }] });
  const decideWithExplicitAllow = (tool: string) => explicitAllowPolicy.decide({
    role: 'admin', agentMode: 'plan', sessionId: 'plan', tool, args: {}, cwd: '/tmp', workspaceRoot: '/tmp', identity: 'admin',
  });
  assert.deepEqual(decideWithExplicitAllow('lsp_apply_workspace_edit'), { effect: 'deny', rule: 'builtin.plan.no-lsp-mutation', explicit: false });
  assert.deepEqual(decideWithExplicitAllow('go_to_definition'), { effect: 'allow', rule: 'builtin.plan.lsp-navigation', explicit: false });
});
