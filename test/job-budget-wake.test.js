import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, durableError, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';

const now = Date.parse('2026-11-13T12:00:00.000Z');
function setup(t, filename = ':memory:') {
  const database = new DurableDatabase(filename, { now: () => now });
  t.after(() => database.close());
  return { database, jobs: new DurableJobs(database) };
}
function defer(jobs, { id, kind = 'token', taskId = null, grantId = null }) {
  const job = jobs.get(id) || jobs.enqueue({ id, type: 'model', key: id, taskId });
  const running = jobs.claim('worker', { id: job.id });
  assert.ok(running);
  return jobs.fail(running, Object.assign(durableError(kind === 'token' ? 'TOKEN_BUDGET_EXHAUSTED' : 'MONEY_BUDGET_EXHAUSTED', 'private body', 429), {
    detail: { kind, blockedScopes: grantId ? ['lease'] : ['workspace'], lease: { grantId } }
  }));
}
function task(jobs, id, data = {}, status = 'active') {
  jobs.db.prepare('INSERT INTO tasks(id,data_json,status,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(id, JSON.stringify(data), status, iso(now), iso(now));
}

test('one persisted event drains successive batches at the same millisecond without reawakening quota losers', t => {
  const { jobs } = setup(t);
  for (const id of ['a', 'b', 'c']) defer(jobs, { id });
  const event = jobs.startBudgetWake({ key: 'settlement:one', kind: 'token' });
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id, limit: 1 }), { eventId: event.id, woken: ['a'], hasMore: true });
  defer(jobs, { id: 'a' });
  assert.equal(jobs.get('a').budget_wake_epoch, event.id);
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id, limit: 1 }).woken, ['b']);
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id, limit: 1 }), { eventId: event.id, woken: ['c'], hasMore: false });
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id }).woken, []);
  assert.equal(jobs.startBudgetWake({ key: 'settlement:one', kind: 'token' }).id, event.id);
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id }).woken, []);
  const next = jobs.startBudgetWake({ key: 'settlement:two', kind: 'token' });
  assert.ok(next.id > event.id);
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: next.id }).woken.sort(), ['a', 'b', 'c']);
  assert.equal(jobs.get('a').attempts, 2);
  assert.equal(jobs.get('a').budget_deferrals, 2);
});

test('wake scope keeps token, model fees, transaction grants and tasks separate', t => {
  const { jobs } = setup(t);
  task(jobs, 'A'); task(jobs, 'B');
  defer(jobs, { id: 'ta', taskId: 'A' }); defer(jobs, { id: 'tb', taskId: 'B' });
  defer(jobs, { id: 'ma', kind: 'model', taskId: 'A' });
  defer(jobs, { id: 'x1', kind: 'transaction', taskId: 'A', grantId: 'g1' });
  defer(jobs, { id: 'x2', kind: 'transaction', taskId: 'A', grantId: 'g2' });
  const wake = fields => jobs.wakeBudgetDeferred({ eventId: jobs.startBudgetWake(fields).id }).woken;
  assert.deepEqual(wake({ key: 'task-A', kind: 'token', taskId: 'A' }), ['ta']);
  assert.deepEqual(wake({ key: 'grant-g1', kind: 'transaction', grantId: 'g1' }), ['x1']);
  assert.deepEqual(wake({ key: 'model-fee', kind: 'model' }), ['ma']);
  assert.equal(jobs.get('tb').available_at, '9999-12-31T23:59:59.999Z');
  assert.equal(jobs.get('x2').available_at, '9999-12-31T23:59:59.999Z');
});

test('completed, cancelled, paused, deleted or privacy-invalidated work cannot be revived', t => {
  const { jobs } = setup(t);
  for (const id of ['done', 'cancel', 'paused', 'forgot', 'deleted', 'valid']) {
    task(jobs, id); defer(jobs, { id, taskId: id });
  }
  jobs.db.prepare("UPDATE tasks SET status='completed' WHERE id='done'").run();
  jobs.cancelTask('cancel');
  jobs.db.prepare("UPDATE tasks SET data_json=? WHERE id='paused'").run(JSON.stringify({ control: { paused: true } }));
  jobs.db.prepare("UPDATE tasks SET data_json=? WHERE id='forgot'").run(JSON.stringify({ privacyInvalidated: true }));
  jobs.db.prepare("DELETE FROM tasks WHERE id='deleted'").run();
  const event = jobs.startBudgetWake({ key: 'workspace-change', kind: 'token' });
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id }).woken, ['valid']);
  assert.equal(jobs.get('cancel').state, 'cancelled');
});

test('release facts are scope-bound and batches reject missing events or invalid limits', t => {
  const { jobs } = setup(t);
  jobs.startBudgetWake({ key: 'same', kind: 'token' });
  assert.throws(() => jobs.startBudgetWake({ key: 'same', kind: 'model' }), { code: 'BUDGET_WAKE_CONFLICT' });
  for (const fields of [{ key: '', kind: 'token' }, { key: 'bad', kind: 'other' }, { key: 'bad', kind: 'token', grantId: 'g' }]) {
    assert.throws(() => jobs.startBudgetWake(fields), { code: 'INVALID_BUDGET_WAKE' });
  }
  for (const limit of [0, 101, 1.5, '1', NaN]) {
    assert.throws(() => jobs.wakeBudgetDeferred({ eventId: 1, limit }), { code: 'INVALID_BUDGET_WAKE' });
  }
  assert.throws(() => jobs.wakeBudgetDeferred({ eventId: 999 }), { code: 'BUDGET_WAKE_MISSING' });
});

test('restart resumes the persisted batch and cannot turn a duplicated release into a new event', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-wake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'workspace.sqlite');
  let database = new DurableDatabase(filename, { now: () => now });
  let jobs = new DurableJobs(database);
  defer(jobs, { id: 'a' }); defer(jobs, { id: 'b' });
  const event = jobs.startBudgetWake({ key: 'release:receipt:1', kind: 'token' });
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id, limit: 1 }).woken, ['a']);
  defer(jobs, { id: 'a' });
  database.close();
  database = new DurableDatabase(filename, { now: () => now });
  t.after(() => database.close());
  jobs = new DurableJobs(database);
  assert.equal(jobs.startBudgetWake({ key: 'release:receipt:1', kind: 'token' }).id, event.id);
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id }).woken, ['b']);
  assert.equal(jobs.claim('worker', { id: 'a' }), null);
});

test('a release between failed admission and durable deferral causes exactly one bounded recheck', t => {
  const { jobs } = setup(t);
  const job = jobs.enqueue({ id: 'raced', type: 'model', key: 'raced' });
  const running = jobs.claim('worker');
  const event = jobs.startBudgetWake({ key: 'release-raced', kind: 'token' });
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id }).woken, []);
  const error = Object.assign(durableError('TOKEN_BUDGET_EXHAUSTED', 'admission failed before release', 429), {
    detail: { blockedScopes: ['workspace'] }
  });
  assert.equal(jobs.fail(running, error).available_at, iso(now));
  assert.ok(jobs.claim('recheck', { id: job.id }));
  jobs.fail(jobs.get(job.id), error);
  assert.equal(jobs.get(job.id).available_at, '9999-12-31T23:59:59.999Z');
  assert.equal(jobs.claim('must-not-poll'), null);
  assert.deepEqual(jobs.wakeBudgetDeferred({ eventId: event.id }).woken, []);
});
