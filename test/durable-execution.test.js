import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';

const workerPath = fileURLToPath(new URL('./fixtures/durable-worker.mjs', import.meta.url));
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-durable-'));
  let now = Date.now();
  const database = new DurableDatabase(path.join(directory, 'workspace.sqlite'), { now: () => now, ...options });
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 }), tasks = new DurableTasks(database, jobs);
  const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: 40 });
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { database, jobs, tasks, ledger, directory, setNow: value => { now = value; }, advance: value => { now += value; } };
}
function running(context, key = 'work') {
  const created = context.tasks.createOrLoad({ candidateKey: key, data: { subject: key, request: { subjectEntity: 'project', deliverable: 'report' } } });
  const job = context.jobs.claim('worker'), run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, job, run };
}
function intent(context, current, key = 'write', resourceId = 'same-resource') {
  return context.ledger.intent({ ...current, provider: 'fixture', tool: 'send', actionFamily: 'fixture.send', resourceId, key, effect: { type: 'fixture' }, payload: {}, authorize: () => ({ allowed: true }) });
}
function event(context, id, material = id) {
  context.database.atomic(() => {
    context.database.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run(id, 'fixture', id, '{}', material, iso(context.database.now()));
    context.database.db.prepare('INSERT INTO source_records(kind,id,created_at) VALUES(\'event\',?,?)').run(id, iso(context.database.now()));
  });
}

test('v0.3/01 two real worker processes can claim a job only once', async t => {
  const context = fixture(t); context.jobs.enqueue({ type: 'work', key: 'only-one' });
  const children = [1, 2].map(() => fork(workerPath, ['claim', context.database.filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => children.forEach(child => { if (child.exitCode == null) child.kill('SIGKILL'); }));
  await Promise.all(children.map(child => once(child, 'message')));
  const messages = children.map(child => once(child, 'message'));
  children.forEach(child => child.send({ claim: true }));
  const results = await Promise.all(messages);
  assert.equal(results.filter(([message]) => message.claimed).length, 1);
  await Promise.all(children.map(child => child.exitCode == null ? once(child, 'exit') : Promise.resolve()));
});

test('v0.3/02 expired jobs require inspection rather than automatic replay', t => {
  const context = fixture(t), current = running(context);
  context.advance(30001); context.jobs.expire();
  assert.equal(context.jobs.get(current.job.id).state, 'recovery_required');
  assert.equal(context.jobs.claim('second'), null);
  assert.throws(() => context.jobs.recover(current.job.id, () => ({ state: 'queued' })), /safe re-execution/);
  context.jobs.recover(current.job.id, () => ({ state: 'queued', safeToRepeat: true }));
  assert.ok(context.jobs.claim('second'));
});

test('v0.3/03 stale worker tokens cannot heartbeat, complete or checkpoint after takeover', t => {
  const context = fixture(t), current = running(context);
  context.advance(30001); context.jobs.expire(); context.jobs.recover(current.job.id, () => ({ state: 'queued', safeToRepeat: true }));
  const next = context.jobs.claim('replacement'); assert.ok(next.lease_token > current.job.lease_token);
  assert.equal(context.jobs.heartbeat(current.job), false);
  assert.throws(() => context.jobs.complete(current.job), /no longer owns/);
  assert.throws(() => context.tasks.checkpoint(current.run, current.job, { expectedInputVersion: 0, plan: {} }), /no longer owns/);
});

test('v0.3/04 external acceptance survives an actual process crash without redispatch', async t => {
  const context = fixture(t); let accepted = 0;
  const provider = http.createServer((_req, res) => { accepted++; res.writeHead(200); res.end('{}'); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const child = fork(workerPath, ['crash-after-send', context.database.filename, `http://127.0.0.1:${provider.address().port}`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  assert.equal((await once(child, 'exit'))[0], 23);
  const execution = context.ledger.byKey('crash-write'); assert.equal(execution.status, 'dispatched');
  const result = await context.ledger.reconcile(execution.id, { lookup: async () => ({ status: 'found', receipt: { id: 'remote-1' } }) });
  assert.equal(result.status, 'found'); assert.equal(context.ledger.get(execution.id).status, 'verified');
  assert.equal(accepted, 1);
});

test('v0.3/05 ambiguous timeouts retain claims and a provider search miss cannot authorize retry', async t => {
  const context = fixture(t), current = running(context), pending = intent(context, current);
  await assert.rejects(context.ledger.dispatch(pending, { ...current, send: async () => new Promise(() => {}) }), /unknown/);
  assert.equal(context.ledger.get(pending.execution.id).status, 'unknown');
  const result = await context.ledger.reconcile(pending.execution.id, { lookup: async () => ({ status: 'not_found' }) });
  assert.equal(result.status, 'unknown'); assert.equal(result.manual, true);
  context.advance(60000);
  assert.throws(() => intent(context, current, 'second-write'), /no longer owns|reconcile|resource/i);
});

test('v0.3/06 new input makes an active run dirty until a fresh checkpoint incorporates it', t => {
  const context = fixture(t), current = running(context); event(context, 'quote');
  context.tasks.associate(current.taskId, 'quote');
  assert.equal(context.tasks.get(current.taskId).inputVersion, 1);
  assert.throws(() => context.tasks.preResume(current.run, current.job), /New task context/);
  assert.throws(() => intent(context, current), /New task context/);
  context.tasks.checkpoint(current.run, current.job, { expectedInputVersion: 1, plan: { quote: 'incorporated' } });
  assert.equal(context.tasks.preResume(current.run, current.job).inputVersion, 1);
});

test('evidence signals persist until a current run acknowledges a checkpoint containing their source', t => {
  const context = fixture(t), current = running(context);
  event(context, 'new-evidence');
  context.tasks.associate(current.taskId, 'new-evidence');
  context.tasks.associate(current.taskId, 'new-evidence');
  const db = context.database.db;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM task_signals WHERE status='PENDING'").get().n, 1);
  assert.throws(() => context.tasks.acknowledgeEvidence(current.run, current.job), /New task context/);
  context.tasks.checkpoint(current.run, current.job, { expectedInputVersion: 1, plan: {}, sources: [] });
  assert.equal(context.tasks.acknowledgeEvidence(current.run, current.job), 0);
  context.tasks.checkpoint(current.run, current.job, { expectedInputVersion: 1, plan: {}, sources: [{ kind: 'event', id: 'new-evidence' }] });
  assert.equal(context.tasks.acknowledgeEvidence(current.run, current.job), 1);
  assert.equal(context.tasks.acknowledgeEvidence(current.run, current.job), 0);
  assert.equal(db.prepare('SELECT status FROM task_signals').get().status, 'CONSUMED');
});

test('different provider events with identical content remain distinct evidence', t => {
  const context = fixture(t), current = running(context);
  event(context, 'first-copy', 'same-content'); event(context, 'second-copy', 'same-content');
  context.tasks.associate(current.taskId, 'first-copy');
  context.tasks.associate(current.taskId, 'second-copy');
  assert.equal(context.tasks.get(current.taskId).inputVersion, 2);
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM task_signals WHERE task_id=? AND status='PENDING'").get(current.taskId).n, 2);
});

test('an existing version-one workspace migrates to the signal inbox without losing tasks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-signal-migration-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let database = new DurableDatabase(filename);
  const tasks = new DurableTasks(database, new DurableJobs(database));
  tasks.createOrLoad({ id: 'existing', candidateKey: 'existing' });
  database.atomic(() => { database.db.exec('DROP TABLE task_signals'); database.db.pragma('user_version=1'); });
  database.close();
  database = new DurableDatabase(filename);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(database.db.pragma('user_version', { simple: true }), 5);
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_signals'").get());
  assert.ok(database.db.prepare('SELECT 1 FROM tasks WHERE id=?').get('existing'));
});

test('a version-three workspace migrates pair caches without losing tasks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pair-migration-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let database = new DurableDatabase(filename);
  const tasks = new DurableTasks(database, new DurableJobs(database));
  tasks.createOrLoad({ id: 'existing', candidateKey: 'existing' });
  database.atomic(() => { database.db.exec('DROP TABLE negative_pair_cache; DROP TABLE activation_decisions'); database.db.pragma('user_version=3'); });
  database.close(); database = new DurableDatabase(filename);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(database.db.pragma('user_version', { simple: true }), 5);
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='negative_pair_cache'").get());
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='activation_decisions'").get());
  assert.ok(database.db.prepare('SELECT 1 FROM tasks WHERE id=?').get('existing'));
});

test('a version-four workspace migrates to activation tables and a newer database is refused', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-activation-migration-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let database = new DurableDatabase(filename);
  database.atomic(() => { database.db.exec('DROP TABLE standing_intents'); database.db.pragma('user_version=4'); });
  database.close();
  database = new DurableDatabase(filename);
  assert.equal(database.db.pragma('user_version', { simple: true }), 5);
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='standing_intents'").get());
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tentative_claims'").get());
  database.close();
  database = new DurableDatabase(filename);
  assert.equal(database.db.pragma('user_version', { simple: true }), 5);
  database.db.pragma('user_version=99');
  database.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => new DurableDatabase(filename), /newer application/);
});

test('v0.3/07 a duplicate candidate adds a continuation to the existing waiting task, never another initial run', t => {
  const context = fixture(t); event(context, 'first'); event(context, 'second');
  const created = context.tasks.createOrLoad({ candidateKey: 'same', eventId: 'first', data: { status: 'waiting_for_information' } });
  const repeated = context.tasks.createOrLoad({ candidateKey: 'same', eventId: 'second' });
  assert.equal(created.taskId, repeated.taskId); assert.equal(repeated.createdNew, false);
  assert.equal(repeated.inputVersion, 2);
  assert.equal(context.jobs.list().filter(job => job.job_type === 'task_initial').length, 1);
  assert.equal(context.jobs.list().filter(job => job.job_type === 'task_continue').length, 1);
});

test('v0.3/08 two tasks cannot dispatch competing writes even after the first resource lease expires', async t => {
  const context = fixture(t), first = running(context, 'first'), held = intent(context, first, 'first-write');
  await assert.rejects(context.ledger.dispatch(held, { ...first, send: async () => new Promise(() => {}) }));
  context.advance(60000);
  const second = running(context, 'second');
  assert.throws(() => intent(context, second, 'second-write'), /reconcile/);
  assert.equal(context.database.db.prepare('SELECT lease_token FROM resource_claims').get().lease_token, 1);
});

test('v0.3/09 SQLITE_BUSY retries roll back before retrying inbox and checkpoint transactions', async t => {
  const context = fixture(t, { busyTimeoutMs: 0, coordinator: { baseDelayMs: 5 } }), current = running(context);
  const lock = new DurableDatabase(context.database.filename); t.after(() => lock.close());
  lock.db.exec('BEGIN IMMEDIATE');
  const pending = context.database.write(() => { event(context, 'after-busy'); context.tasks.checkpoint(current.run, current.job, { expectedInputVersion: 0, plan: { durable: true } }); });
  setTimeout(() => lock.db.exec('ROLLBACK'), 25);
  await pending;
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM durable_inbox WHERE id='after-busy'").get().n, 1);
  assert.equal(context.database.db.inTransaction, false);
});

test('v0.3/10 a killed process retains its committed inbox and job together', async t => {
  const context = fixture(t), child = fork(workerPath, ['commit', context.database.filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  await once(child, 'message'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM durable_inbox WHERE id='committed'").get().n, 1);
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM jobs WHERE idempotency_key='committed'").get().n, 1);
  assert.equal(context.database.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('recovery exhaustion dead-letters a job instead of leaving an unclaimable queued row', t => {
  const context = fixture(t);
  const enqueued = context.jobs.enqueue({ type: 'bounded', key: 'bounded', maxAttempts: 1 });
  context.jobs.claim('worker'); context.advance(30001); context.jobs.expire();
  const result = context.jobs.recover(enqueued.id, () => ({ state: 'queued', safeToRepeat: true }));
  assert.equal(result.state, 'dead'); assert.equal(result.dead_letter_reason, 'attempts_exhausted');
});

test('provider verification has a hard deadline and cannot leave an accepted write running forever', async t => {
  const context = fixture(t), current = running(context), pending = intent(context, current);
  await assert.rejects(context.ledger.dispatch(pending, { ...current, send: async () => ({ id: 'accepted' }), verify: async () => new Promise(() => {}) }), /unknown/);
  assert.equal(context.ledger.get(pending.execution.id).status, 'unknown');
});
