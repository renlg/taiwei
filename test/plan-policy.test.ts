import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentProfile, toolDenied } from '../src/agents/profiles.js';
import { PolicyEngine } from '../src/security/policy.js';

function decide(tool: string, role: 'admin' | 'guest', agentMode: 'plan' | 'build') {
  return new PolicyEngine().decide({
    role, agentMode, sessionId: role, tool, args: {}, cwd: '/tmp', workspaceRoot: '/tmp', identity: role,
  });
}

test('plan mode denies watchdog mutations and nginx proxy changes at both policy gates', () => {
  const profile = getAgentProfile('plan');
  for (const tool of ['watchdog_register', 'watchdog_remove', 'nginx_add_proxy']) {
    assert.deepEqual(decide(tool, 'admin', 'plan'), {
      effect: 'deny', rule: 'builtin.plan.read-only', explicit: false,
    });
    assert.equal(toolDenied(tool, profile), true);
  }
});

test('guest build mode keeps nginx proxy access and watchdog denial unchanged', () => {
  assert.deepEqual(decide('nginx_add_proxy', 'guest', 'build'), {
    effect: 'allow', rule: 'builtin.guest.nginx-add-proxy', explicit: false, allowExternalPath: true,
  });
  assert.equal(decide('watchdog_register', 'guest', 'build').rule, 'builtin.guest.no-watchdog-management');
});
