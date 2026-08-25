import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PolicyEngine } from '../src/security/policy.js';
import { createBashTool } from '../src/tools/impl/bash.js';
import { ToolRegistry } from '../src/tools/registry.js';

test('guest skill scripts may source dynamic skill-internal dependencies only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-guest-skill-'));
  try {
    const guestHome = join(directory, 'guest1');
    const workspace = join(guestHome, 'projects');
    const skill = join(guestHome, '.taiwei', 'skills', 'weather');
    await mkdir(join(skill, 'lib'), { recursive: true });
    await mkdir(workspace, { recursive: true });

    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(createBashTool({
      lookupOsUser: async () => 'guest1',
      lookupGiteaBaseUrl: async () => undefined,
      isRoot: () => true,
      executeFile: async () => { executions += 1; return { stdout: 'ok', stderr: '' }; },
    }));
    const policy = new PolicyEngine({ rules: [{ match: { role: 'guest', tool: 'bash' }, effect: 'allow' }] });
    const run = (command: string) => registry.dispatch('bash', { command }, {
      cwd: workspace, workspaceRoot: workspace, role: 'guest', identity: 'alice', policy,
    });

    const main = join(skill, 'weather.sh');
    await writeFile(main, '#!/bin/bash\nSCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nsource "${SCRIPT_DIR}/lib/x.sh"\n');
    await writeFile(join(skill, 'lib', 'x.sh'), '#!/bin/bash\necho safe\n');
    const allowed = JSON.parse(await run(`bash ${main}`)) as { error?: string };
    assert.equal(allowed.error, undefined);
    assert.equal(executions, 1);

    await writeFile(join(skill, 'lib', 'x.sh'), '#!/bin/bash\nsource "${UNKNOWN}/nested.sh"\n');
    assert.match(await run(`bash ${main}`), /无法安全解析脚本路径/);
    assert.equal(executions, 1);

    const workspaceScript = join(workspace, 'dynamic.sh');
    await writeFile(workspaceScript, '#!/bin/bash\nsource "${VAR}/x.sh"\n');
    assert.match(await run(`bash ${workspaceScript}`), /无法安全解析脚本路径/);
    assert.equal(executions, 1);

    await writeFile(main, '#!/bin/bash\nsource "${SCRIPT_DIR}/../../etc/passwd"\n');
    assert.match(await run(`bash ${main}`), /路径越界（脚本内容）/);
    assert.equal(executions, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
