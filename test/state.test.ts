import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CronJobStore } from '../src/cron/jobs.js';
import { CronRunLedger, type CronRun } from '../src/cron/runs.js';
import { AuthSessionStore } from '../src/gateway/auth.js';
import { LoginLockStore } from '../src/gateway/login-locks.js';
import { SessionStore, type GatewaySession, type SessionMessage } from '../src/gateway/sessions.js';
import { closeStateDatabases, openStateDatabase } from '../src/state/db.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const GUEST_SESSION_ID = '00000000-0000-4000-8000-000000000002';

function message(content: string, timestamp: string): SessionMessage {
  return { role: 'user', content, timestamp };
}

function legacySession(id: string, title: string): GatewaySession {
  return {
    id, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [message(title, '2026-01-01T00:00:00.000Z')], agentId: 'build',
  };
}

test('state.db stores sessions with guest isolation and merges concurrent saves', async () => {
  const home = await mkdtemp(join(tmpdir(), 'taiwei-state-session-'));
  const admin = new SessionStore(join(home, 'sessions'));
  const guest = new SessionStore(join(home, 'guests', 'guest-alice', 'sessions'));
  try {
    const session = await admin.create('build');
    session.title = 'round trip';
    session.contextMessages = [{ role: 'user', content: 'context' }];
    await admin.save(session);
    assert.equal((await admin.get(session.id))?.title, 'round trip');
    assert.deepEqual((await admin.get(session.id))?.contextMessages, session.contextMessages);

    const guestSession = await guest.create('plan');
    assert.equal(await admin.get(guestSession.id), undefined);
    assert.equal(await guest.get(session.id), undefined);
    assert.deepEqual((await guest.list()).map(({ id }) => id), [guestSession.id]);
    await assert.rejects(guest.save({ ...structuredClone(session), title: 'guest takeover' }), /another owner/);
    assert.equal((await admin.get(session.id))?.title, 'round trip');

    const first = await admin.get(session.id);
    const second = await admin.get(session.id);
    assert.ok(first && second);
    first.messages.push(message('first writer', '2026-02-01T00:00:00.000Z'));
    second.messages.push(message('second writer', '2026-02-01T00:00:01.000Z'));
    await Promise.all([admin.save(first), admin.save(second)]);
    const mergedContents = (await admin.get(session.id))?.messages.map(({ content }) => content) ?? [];
    assert.deepEqual([...mergedContents].sort(), ['first writer', 'second writer'].sort());
  } finally {
    await closeStateDatabases();
    await rm(home, { recursive: true, force: true });
  }
});

test('state.db stores cron jobs and cron run history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'taiwei-state-cron-'));
  const jobs = new CronJobStore(join(home, 'cron.json'));
  const ledger = new CronRunLedger(20, join(home, 'cron-runs.jsonl'));
  try {
    const job = await jobs.add({ name: 'sqlite job', schedule: '1h', kind: 'agent', prompt: 'work' });
    assert.equal((await jobs.list())[0]?.name, 'sqlite job');
    assert.equal((await jobs.update(job.id, { name: 'updated' }))?.name, 'updated');
    assert.equal(await jobs.setEnabled(job.id, false), true);
    assert.equal((await jobs.list())[0]?.enabled, false);

    const run: CronRun = {
      jobId: job.id, kind: 'agent', startedAt: '2026-03-01T00:00:00.000Z',
      endedAt: '2026-03-01T00:00:01.000Z', status: 'ok', output: 'done', tokens: 12,
    };
    await ledger.append(run);
    assert.deepEqual(await ledger.list(job.id), [run]);
    assert.deepEqual(ledger.lastRuns(job.id), [run]);
    assert.equal(await jobs.remove(job.id), true);
    assert.deepEqual(await jobs.list(), []);
  } finally {
    await closeStateDatabases();
    await rm(home, { recursive: true, force: true });
  }
});

test('legacy JSON state imports once into SQLite and is retained as timestamped backups', async () => {
  const home = await mkdtemp(join(tmpdir(), 'taiwei-state-migration-'));
  const adminDirectory = join(home, 'sessions');
  const guestDirectory = join(home, 'guests', 'guest-alice', 'sessions');
  await mkdir(adminDirectory, { recursive: true });
  await mkdir(guestDirectory, { recursive: true });
  await writeFile(join(adminDirectory, `${SESSION_ID}.json`), JSON.stringify(legacySession(SESSION_ID, 'admin legacy')));
  await writeFile(join(guestDirectory, `${GUEST_SESSION_ID}.json`), JSON.stringify(legacySession(GUEST_SESSION_ID, 'guest legacy')));
  await writeFile(join(home, 'cron.json'), JSON.stringify([{ id: 'legacy-job', name: 'legacy', schedule: '1h', prompt: 'work', kind: 'agent' }]));
  const legacyRun: CronRun = { jobId: 'legacy-job', kind: 'agent', startedAt: '2026-01-02T00:00:00.000Z', endedAt: '2026-01-02T00:00:01.000Z', status: 'ok' };
  await writeFile(join(home, 'cron-runs.jsonl'), `${JSON.stringify(legacyRun)}\n`);
  const token = 'a'.repeat(64);
  await writeFile(join(home, 'gateway-sessions.json'), JSON.stringify({
    [token]: { username: 'legacy-admin', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
  }));
  await writeFile(join(home, 'login-locks.json'), JSON.stringify({
    pairs: { '["admin","127.0.0.1"]': { totalFailures: 10, recentFailures: [], permanent: true } }, ips: {},
  }));

  const admin = new SessionStore(adminDirectory);
  const guest = new SessionStore(guestDirectory);
  const jobs = new CronJobStore(join(home, 'cron.json'));
  const runs = new CronRunLedger(20, join(home, 'cron-runs.jsonl'));
  const auth = new AuthSessionStore(join(home, 'gateway-sessions.json'));
  const locks = new LoginLockStore(join(home, 'login-locks.json'));
  try {
    await Promise.all([admin.initialize(), guest.initialize(), runs.initialize(), auth.initialize(), locks.initialize()]);
    assert.equal((await admin.get(SESSION_ID))?.title, 'admin legacy');
    assert.equal((await guest.get(GUEST_SESSION_ID))?.title, 'guest legacy');
    assert.equal((await jobs.list())[0]?.id, 'legacy-job');
    assert.deepEqual(await runs.list('legacy-job'), [legacyRun]);
    assert.equal((await auth.authenticate(token))?.username, 'legacy-admin');
    assert.equal((await locks.attempt('admin', '127.0.0.1', true)).lock, 'pair_permanent');

    for (const [directory, prefix] of [
      [adminDirectory, `${SESSION_ID}.json.bak-`], [guestDirectory, `${GUEST_SESSION_ID}.json.bak-`],
      [home, 'cron.json.bak-'], [home, 'cron-runs.jsonl.bak-'], [home, 'gateway-sessions.json.bak-'], [home, 'login-locks.json.bak-'],
    ]) assert.ok((await readdir(directory)).some((name) => name.startsWith(prefix)), `missing backup ${prefix}`);

    const state = await openStateDatabase(join(home, 'state.db'));
    const counts = await state.serial((db) => ({
      sessions: (db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count,
      jobs: (db.prepare('SELECT count(*) AS count FROM cron_jobs').get() as { count: number }).count,
      runs: (db.prepare('SELECT count(*) AS count FROM cron_runs').get() as { count: number }).count,
    }));
    assert.deepEqual(counts, { sessions: 2, jobs: 1, runs: 1 });
    await Promise.all([admin.initialize(), guest.initialize(), runs.initialize(), auth.initialize(), locks.initialize()]);
    assert.deepEqual(await runs.list('legacy-job'), [legacyRun]);
  } finally {
    await closeStateDatabases();
    await rm(home, { recursive: true, force: true });
  }
});

test('stores fall back to legacy JSON when node:sqlite is unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'taiwei-state-fallback-'));
  const previous = process.env.TAIWEI_DISABLE_SQLITE;
  process.env.TAIWEI_DISABLE_SQLITE = '1';
  try {
    const sessions = new SessionStore(join(home, 'sessions'));
    const created = await sessions.create();
    assert.equal((await sessions.get(created.id))?.id, created.id);
    assert.match(await readFile(join(home, 'sessions', `${created.id}.json`), 'utf8'), new RegExp(created.id));

    const jobs = new CronJobStore(join(home, 'cron.json'));
    await jobs.add('fallback', '1h', 'work');
    assert.match(await readFile(join(home, 'cron.json'), 'utf8'), /fallback/);
    const runs = new CronRunLedger(20, join(home, 'cron-runs.jsonl'));
    await runs.append({ jobId: 'fallback', kind: 'agent', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', status: 'ok' });
    assert.match(await readFile(join(home, 'cron-runs.jsonl'), 'utf8'), /fallback/);
  } finally {
    if (previous === undefined) delete process.env.TAIWEI_DISABLE_SQLITE; else process.env.TAIWEI_DISABLE_SQLITE = previous;
    await rm(home, { recursive: true, force: true });
  }
});
