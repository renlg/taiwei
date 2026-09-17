import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { constrainGuestBash } from '../src/tools/impl/bash.js';

test('guest bash permits workspace deployment commands without weakening path checks', async () => {
  const guestRoot = await mkdtemp(join(tmpdir(), 'taiwei-guest-bash-'));
  const workspace = join(guestRoot, 'projects');
  await mkdir(workspace);
  try {
    const deployment = 'cd ' + workspace + ' && OLD_PID=$(lsof -nP -t -iTCP:10001 -sTCP:LISTEN 2>/dev/null | head -1) && [ -n "$OLD_PID" ] && kill $OLD_PID && sleep 1; nohup /usr/bin/python3 backend.py > app.log 2>&1 & sleep 2';

    assert.equal(await constrainGuestBash(deployment, workspace, guestRoot), undefined);
    assert.match((await constrainGuestBash('cat /etc/passwd', workspace, guestRoot))?.error ?? '', /路径越界|凭据/);
    assert.match((await constrainGuestBash('rm /root/x', workspace, guestRoot))?.error ?? '', /路径越界/);
    assert.match((await constrainGuestBash('touch /tmp/x', workspace, guestRoot))?.error ?? '', /路径越界/);
    assert.match((await constrainGuestBash('echo $(cat /etc/passwd)', workspace, guestRoot))?.error ?? '', /路径越界|凭据/);
  } finally {
    await rm(guestRoot, { recursive: true, force: true });
  }
});
