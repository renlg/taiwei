import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, initializeConfig, loadConfig, type BashBackend, type BashConfig } from '../src/config/config.js';
import { buildDockerInvocation, buildSshInvocation, createBashTool, shellQuote, type BashBackendExecutor, type BashBackendRequest } from '../src/tools/impl/bash.js';

async function temporaryHome(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-bash-backend-'));
  const previous = process.env.TAIWEI_HOME;
  process.env.TAIWEI_HOME = directory;
  try { await run(directory); }
  finally {
    if (previous === undefined) delete process.env.TAIWEI_HOME;
    else process.env.TAIWEI_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const request = (config: BashConfig, command = 'printf ok', cwd = '/srv/work'): BashBackendRequest => ({
  config, command, cwd, timeout: 1234, maxBuffer: 4096,
});

test('bash config defaults to local and nested backend config survives load and initialize', async () => temporaryHome(async (directory) => {
  assert.deepEqual(DEFAULT_CONFIG.bash, { backend: 'local' });
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    bash: {
      backend: 'docker',
      docker: { image: 'node:22', network: 'none', extraArgs: ['--read-only'] },
      ssh: { host: 'prod.example', port: 2222, user: 'deploy', keyPath: '~/.ssh/id_ed25519' },
    },
  }));
  const loaded = await loadConfig();
  assert.deepEqual(loaded.bash, {
    backend: 'docker',
    docker: { image: 'node:22', network: 'none', extraArgs: ['--read-only'] },
    ssh: { host: 'prod.example', port: 2222, user: 'deploy', keyPath: '~/.ssh/id_ed25519' },
  });
  const initialized = await initializeConfig();
  assert.deepEqual(initialized.bash, loaded.bash);
  const persisted = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { bash: BashConfig };
  assert.deepEqual(persisted.bash, loaded.bash);
}));

test('admin bash selects the configured backend while guest always keeps runuser', async () => {
  const selected: BashBackend[] = [];
  const fake = (backend: BashBackend): BashBackendExecutor => async (backendRequest) => {
    selected.push(backend);
    assert.equal(backendRequest.timeout, 7654);
    assert.equal(backendRequest.command, 'printf ok');
    return { stdout: backend, stderr: '' };
  };
  let config: BashConfig = { backend: 'local' };
  const runuserCalls: string[] = [];
  const tool = createBashTool({
    loadBashConfig: async () => config,
    backendExecutors: { local: fake('local'), docker: fake('docker'), ssh: fake('ssh') },
    lookupOsUser: async () => 'guest1', isRoot: () => true,
    executeFile: async (file) => { runuserCalls.push(file); return { stdout: 'guest', stderr: '' }; },
  });
  const context = { cwd: '/tmp', workspaceRoot: '/tmp', role: 'admin' as const, identity: 'admin' };
  for (const backend of ['local', 'docker', 'ssh'] as const) {
    config = backend === 'docker' ? { backend, docker: { image: 'node:22' } }
      : backend === 'ssh' ? { backend, ssh: { host: 'example.test' } } : { backend };
    const result = await tool.execute({ command: 'printf ok', timeout_ms: 7654 }, context) as { stdout: string };
    assert.equal(result.stdout, backend);
  }
  config = { backend: 'docker', docker: { image: 'node:22' } };
  const guest = await tool.execute({ command: 'printf ok' }, { ...context, role: 'guest', identity: 'alice' }) as { stdout?: string; error?: string };
  assert.equal(guest.error, undefined);
  assert.equal(guest.stdout, 'guest');
  assert.deepEqual(selected, ['local', 'docker', 'ssh']);
  assert.deepEqual(runuserCalls, ['runuser']);
});

test('docker invocation mounts only cwd and includes isolation options', () => {
  const invocation = buildDockerInvocation(request({
    backend: 'docker', docker: { image: 'node:22', network: 'none', extraArgs: ['--read-only'] },
  }, 'echo hello', '/safe/project'));
  assert.equal(invocation.file, 'docker');
  assert.deepEqual(invocation.args, [
    'run', '--rm', '-i', '-v', '/safe/project:/work', '-w', '/work',
    '--network', 'none', '--read-only', 'node:22', 'bash', '-c', 'echo hello',
  ]);
  assert.throws(() => buildDockerInvocation(request({ backend: 'docker' })), /bash\.docker\.image/);
});

test('ssh invocation shell-quotes cwd and command and enables noninteractive safeguards', () => {
  const cwd = "/srv/a'; touch /tmp/cwd-injected; echo '";
  const command = "printf '%s' \"hello\"; touch /tmp/command-is-data";
  const invocation = buildSshInvocation(request({
    backend: 'ssh', ssh: { host: 'prod.example', user: 'deploy', port: 2222, keyPath: '/keys/deploy key', commandPrefix: 'sudo -n' },
  }, command, cwd));
  assert.equal(invocation.file, 'ssh');
  assert.deepEqual(invocation.args.slice(0, 8), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '2222', '-i', '/keys/deploy key']);
  assert.equal(invocation.args[8], 'deploy@prod.example');
  assert.equal(invocation.args[9], `cd -- ${shellQuote(cwd)} && sudo -n bash -lc ${shellQuote(command)}`);
  assert.throws(() => buildSshInvocation(request({ backend: 'ssh' })), /bash\.ssh\.host/);
});

test('invalid bash backend is rejected clearly before execution', async () => {
  let executed = false;
  const tool = createBashTool({
    loadBashConfig: async () => ({ backend: 'podman' } as unknown as BashConfig),
    backendExecutors: { local: async () => { executed = true; return { stdout: '', stderr: '' }; } },
  });
  await assert.rejects(
    async () => { await tool.execute({ command: 'true' }, { cwd: '/tmp', workspaceRoot: '/tmp', role: 'admin' }); },
    /bash backend 非法.*podman.*local、docker、ssh/,
  );
  assert.equal(executed, false);
});

test('missing docker and ssh executables return backend-specific errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-empty-path-'));
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  try {
    let config: BashConfig = { backend: 'docker', docker: { image: 'node:22' } };
    const tool = createBashTool({ loadBashConfig: async () => config });
    const context = { cwd: directory, workspaceRoot: directory, role: 'admin' as const };
    await assert.rejects(
      async () => { await tool.execute({ command: 'true' }, context); },
      /backend 'docker' 需要 Docker：docker: command not found/,
    );
    config = { backend: 'ssh', ssh: { host: 'example.test' } };
    await assert.rejects(
      async () => { await tool.execute({ command: 'true' }, context); },
      /backend 'ssh' 需要 SSH client：ssh: command not found/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
