import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../src/tools/registry.js';
import { PluginLoader } from '../src/plugins/loader.js';

async function withHome<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-plugin-worker-test-'));
  const oldHome = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { return await run(directory); }
  finally {
    if (oldHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
}

test('plugin worker isolation: CJS plugin tools execute in a worker thread', async () => {
  await withHome(async (directory) => {
    await mkdir(join(directory, 'plugins', 'worker-ok'), { recursive: true });
    await writeFile(join(directory, 'plugins', 'worker-ok', 'manifest.json'), JSON.stringify({
      name: 'worker-ok', version: '1.0.0', apiVersion: 1, capabilities: ['worker'], main: 'plugin.js',
    }));
    await writeFile(join(directory, 'plugins', 'worker-ok', 'plugin.js'), `module.exports = { name: 'worker-ok', tools: [{ name: 'hello', description: 'says hello', parameters: { type: 'object' }, execute: (args) => 'hello from worker' }] };`);
    const registry = new ToolRegistry();
    const loader = new PluginLoader(registry);
    await loader.reload();
    const listed = loader.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.name, 'worker-ok');
    assert.equal(listed[0]!.tools, 1);
    assert.equal(listed[0]!.error, undefined);
    const result = await registry.dispatch('plugin_worker-ok_hello', {}, { cwd: directory });
    assert.equal(result, 'hello from worker');
    await loader.close();
  });
});

test('plugin worker isolation: a throwing plugin marks itself crashed without killing the host', async () => {
  await withHome(async (directory) => {
    await mkdir(join(directory, 'plugins', 'worker-throw'), { recursive: true });
    await writeFile(join(directory, 'plugins', 'worker-throw', 'manifest.json'), JSON.stringify({
      name: 'worker-throw', version: '1.0.0', apiVersion: 1, capabilities: ['worker'], main: 'plugin.js',
    }));
    await writeFile(join(directory, 'plugins', 'worker-throw', 'plugin.js'), `module.exports = { name: 'worker-throw', tools: [{ name: 'boom', description: 'throws', parameters: { type: 'object' }, execute: () => { throw new Error('worker explosion'); } }] };`);
    const registry = new ToolRegistry();
    const loader = new PluginLoader(registry);
    await loader.reload();
    const result = JSON.parse(await registry.dispatch('plugin_worker-throw_boom', {}, { cwd: directory })) as { error: string };
    assert.match(result.error, /worker explosion/);
    // The plugin should be marked as crashed.
    const status = loader.list().find((item) => item.name === 'worker-throw');
    assert.equal(status?.crashed, true);
    await loader.close();
  });
});

test('plugin worker isolation: main-process capability skips worker and runs inline', async () => {
  await withHome(async (directory) => {
    await mkdir(join(directory, 'plugins', 'inline-plugin'), { recursive: true });
    await writeFile(join(directory, 'plugins', 'inline-plugin', 'manifest.json'), JSON.stringify({
      name: 'inline-plugin', version: '1.0.0', apiVersion: 1, capabilities: ['main-process'], main: 'plugin.js',
    }));
    await writeFile(join(directory, 'plugins', 'inline-plugin', 'plugin.js'), `module.exports = { name: 'inline-plugin', tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object' }, execute: () => 'pong-inline' }] };`);
    const registry = new ToolRegistry();
    const loader = new PluginLoader(registry);
    await loader.reload();
    assert.equal(await registry.dispatch('plugin_inline-plugin_ping', {}, { cwd: directory }), 'pong-inline');
    await loader.close();
  });
});

test('plugin worker preserves config, context, policy checks, skills, and cancellation', async () => {
  await withHome(async (directory) => {
    const pluginDir = join(directory, 'plugins', 'worker-contract');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify({
      name: 'worker-contract', version: '1.0.0', apiVersion: 1, capabilities: ['worker'], main: 'plugin.js', skills: ['manifest-skill.md'],
    }));
    await writeFile(join(pluginDir, 'manifest-skill.md'), '---\nname: manifest-skill\ndescription: From manifest\n---\nManifest body\n');
    await writeFile(join(pluginDir, 'dynamic-skill.md'), '---\nname: dynamic-skill\ndescription: From init\n---\nDynamic body\n');
    await writeFile(join(pluginDir, 'plugin.js'), `module.exports = {
      skills: [{ name: 'exported-skill', description: 'From export', body: 'Exported body' }],
      init: async (api) => {
        await api.registerSkill('dynamic-skill.md');
        const policyEffect = api.policyCheck('internal_check', {}).effect;
        api.registerTool({ name: 'inspect', description: 'inspect runtime', parameters: { type: 'object' } }, (_args, context) => ({
          configured: api.config.answer, policyEffect, cwd: context.cwd, identity: context.identity,
          sessionId: context.sessionId, hasSignal: Boolean(context.signal), role: context.role,
          agentProfile: context.agentProfile, lsp: context.lsp,
        }));
        api.registerTool({ name: 'wait', description: 'wait for cancel', parameters: { type: 'object' } }, (_args, context) =>
          new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })));
      },
    };`);
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      plugins: { 'worker-contract': { config: { answer: 42 } } },
      policy: { rules: [{ match: { tool: 'internal_check' }, effect: 'deny' }] },
    }));
    const registry = new ToolRegistry();
    const loader = new PluginLoader(registry);
    await loader.reload();
    assert.deepEqual(loader.skills().map((skill) => skill.name).sort(), ['dynamic-skill', 'exported-skill', 'manifest-skill']);
    const inspected = JSON.parse(await registry.dispatch('plugin_worker-contract_inspect', {}, {
      cwd: directory, identity: 'alice', role: 'admin', sessionId: 'session-1',
      agentProfile: {
        id: 'custom-build', mode: 'build', prompt: 'Inspect carefully', model: 'test-model', maxTurns: 7,
        toolPolicy: { allow: ['plugin_worker-contract_inspect'], deny: ['lsp_*'] },
      },
      lsp: { enabled: true, maxDiagnostics: 9, autoInject: false, servers: [{ command: 'test-lsp', args: ['--stdio'], extensions: ['.test'] }] },
    })) as Record<string, unknown>;
    assert.deepEqual(inspected, {
      configured: 42, policyEffect: 'deny', cwd: directory, identity: 'alice', sessionId: 'session-1', hasSignal: true, role: 'admin',
      agentProfile: {
        id: 'custom-build', mode: 'build', prompt: 'Inspect carefully', model: 'test-model', maxTurns: 7,
        toolPolicy: { allow: ['plugin_worker-contract_inspect'], deny: ['lsp_*'] },
      },
      lsp: { enabled: true, maxDiagnostics: 9, autoInject: false, servers: [{ command: 'test-lsp', args: ['--stdio'], extensions: ['.test'] }] },
    });

    const controller = new AbortController();
    const waiting = registry.dispatch('plugin_worker-contract_wait', {}, { cwd: directory, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    assert.match(JSON.parse(await waiting).error, /cancelled/);
    await loader.close();
  });
});
