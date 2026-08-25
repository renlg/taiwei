import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UserSkillStore } from '../src/skills/user-store.js';

const skill = (name: string, description = 'A reusable workflow') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Steps\n\n1. Do the reusable thing.\n`;

test('user skill store saves, lists, reads, isolates owners, and deletes without overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-user-skills-'));
  const store = new UserSkillStore(directory);
  const guest = 'guest-alice-0123456789abcdef01234567';
  try {
    assert.equal((await store.save('admin', 'deploy-app', skill('deploy-app'))).created, true);
    assert.equal((await store.save('admin', 'deploy-app', skill('deploy-app', 'Must not overwrite'))).created, false);
    assert.equal((await store.save(guest, 'deploy-app', skill('deploy-app', 'Guest workflow'))).created, true);

    assert.match(await store.read('admin', 'deploy-app'), /A reusable workflow/);
    assert.doesNotMatch(await store.read('admin', 'deploy-app'), /Must not overwrite/);
    assert.deepEqual((await store.list('admin')).map(({ owner, name }) => ({ owner, name })), [{ owner: 'admin', name: 'deploy-app' }]);
    assert.deepEqual((await store.list()).map(({ owner }) => owner), ['admin', guest]);

    assert.equal(await store.delete(guest, 'deploy-app'), true);
    assert.equal(await store.delete(guest, 'deploy-app'), false);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('user skill store rejects unsafe owners, names, and mismatched frontmatter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-user-skills-'));
  const store = new UserSkillStore(directory);
  try {
    await assert.rejects(store.save('../admin', 'safe', skill('safe')), /Invalid user skill owner/);
    await assert.rejects(store.save('admin', '../escape', skill('escape')), /Invalid skill name/);
    await assert.rejects(store.save('admin', 'expected', skill('different')), /frontmatter name/);
    await assert.rejects(store.save('admin', 'missing-description', '---\nname: missing-description\n---\nbody'), /requires name and description/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
