import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { DurableDatabase } from '../src/durable/database.js';

/**
 * A job that reaches `dead` must not leave its task silently in progress.
 * The task gets a terminal, honest state and a decision-supporting notice.
 */
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-dead-letter-'));
  const store = new SqliteStore(path.join(directory, 'state.json'), { database: new DurableDatabase(':memory:') });
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime };
}
function task(c, key = 'dead-letter') {
  const created = c.store.tasks.createOrLoad({ candidateKey: key, data: { subject: key, status: 'investigating', request: { subjectEntity: 'project', deliverable: 'report' } } });
  return c.store.tasks.get(created.taskId);
}
const deadJob = (overrides = {}) => ({ id: 'job-1', job_type: 'task_continue', task_id: 'task-1', attempts: 3, max_attempts: 8, last_error_class: 'retryable', ...overrides });

test('a dead job blocks its task and emits one high-priority blocker', t => {
  const c = setup(t), current = task(c);
  c.runtime.deadLetter({ ...deadJob(), task_id: current.id }, Object.assign(new Error('boom'), { code: 'E_TEST' }));
  const stopped = c.store.state.tasks[current.id];
  assert.equal(stopped.status, 'blocked');
  assert.deepEqual({ attempts: stopped.failure.attempts, maxAttempts: stopped.failure.maxAttempts, jobType: stopped.failure.jobType },
    { attempts: 3, maxAttempts: 8, jobType: 'task_continue' });
  assert.match(stopped.reason, /3 of 8 attempt/);
  const notices = c.store.state.notifications.filter(item => item.taskId === current.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'blocker');
  assert.equal(notices[0].priority, 'high');
  assert.equal(notices[0].dedupeKey, `blocker:${current.id}`);
  assert.ok(notices[0].options.some(option => option.value === 'reopen'));
  assert.ok(notices[0].options.some(option => option.value === 'close'));
  assert.ok(notices[0].checked.length);
});

test('dead-lettering twice keeps one notice and refreshes the reason', t => {
  const c = setup(t), current = task(c);
  c.runtime.deadLetter({ ...deadJob(), task_id: current.id }, new Error('first'));
  c.runtime.deadLetter({ ...deadJob({ attempts: 4 }), task_id: current.id }, new Error('second'));
  const notices = c.store.state.notifications.filter(item => item.taskId === current.id);
  assert.equal(notices.length, 1);
  assert.match(notices[0].what, /4 of 8 attempt/);
  assert.equal(c.store.state.tasks[current.id].failure.attempts, 4);
});

test('a task with an uncertain external action is left to its own blocker', t => {
  const c = setup(t), current = task(c);
  c.store.mutate(state => { state.tasks[current.id].action = { status: 'uncertain', idempotencyKey: 'key-1' }; state.tasks[current.id].status = 'blocked'; });
  c.runtime.deadLetter({ ...deadJob(), task_id: current.id }, new Error('boom'));
  assert.equal(c.store.state.tasks[current.id].failure, undefined);
  assert.equal(c.store.state.notifications.filter(item => item.taskId === current.id).length, 0);
});

test('a completed task is not resurrected as stopped', t => {
  const c = setup(t), current = task(c);
  c.store.mutate(state => { state.tasks[current.id].status = 'completed'; });
  c.runtime.deadLetter({ ...deadJob(), task_id: current.id }, new Error('boom'));
  assert.equal(c.store.state.tasks[current.id].status, 'completed');
});

test('a stopped task is blocked and notifies the user', t => {
  const c = setup(t), current = task(c);
  c.runtime.deadLetter({ ...deadJob(), task_id: current.id }, new Error('boom'));
  const state = c.engine.publicState();
  const stopped = state.tasks.find(item => item.id === current.id);
  assert.equal(stopped.status, 'blocked');
  assert.ok(stopped.failure);
  assert.ok((state.notifications || []).some(item => item.kind === 'blocker' && item.taskId === current.id));
});

test('a job with no task is ignored', t => {
  const c = setup(t);
  assert.equal(c.runtime.deadLetter(deadJob({ task_id: null, payload: {} }), new Error('boom')), null);
  assert.equal(c.store.state.notifications.length, 0);
});

test('a job that dies through the worker blocks its task and notifies the user', async t => {
  const c = setup(t);
  c.engine.ingest({ id: 'mail-event', type: 'email.received', payload: { id: 'm1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send it by Friday.' } });
  c.engine.ingest({ id: 'doc-event', type: 'document.modified', payload: { id: 'cedar', title: 'Cedar project proposal', kind: 'proposal', content: 'Cedar proposal\nExperiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.' } });
  await c.engine.whenSettled();
  const taskId = 'request:m1';
  assert.equal(c.store.tasks.get(taskId).status, 'ready_for_approval');
  const job = c.store.jobs.enqueue({ type: 'task_continue', taskId, key: 'force-failure', payload: { taskId } });
  const original = c.engine.recheckTaskGuidance.bind(c.engine);
  c.engine.recheckTaskGuidance = () => { throw new Error('Injected planning failure'); };
  try { await c.runtime.worker.tick(); } finally { c.engine.recheckTaskGuidance = original; }
  assert.equal(c.store.jobs.get(job.id).state, 'dead');
  assert.equal(c.store.tasks.get(taskId).status, 'blocked');
  assert.match(c.store.tasks.get(taskId).reason, /Stopped after 1 of 8 attempt/);
  const notice = c.store.state.notifications.find(item => item.taskId === taskId && item.kind === 'blocker');
  assert.ok(notice, 'the dead job produced a user-visible blocker');
});

test('recovery that exhausts its attempts converges the task instead of leaving it verifying forever', async t => {
  const c = setup(t), current = task(c, 'unreconcilable');
  // A crash between dispatch and verification: the task sits in `verifying` with
  // an action still marked `executing`, and no uncertain() ran to block it.
  c.store.mutate(state => {
    state.tasks[current.id].status = 'verifying';
    state.tasks[current.id].action = { id: 'send:crashed', idempotencyKey: 'k-crashed', version: 1, permission: 'user_approved', taskId: current.id, status: 'executing' };
  });
  const job = c.store.jobs.enqueue({ type: 'reconcile_execution', taskId: current.id, key: 'reconcile:crashed', maxAttempts: 1 });
  c.store.jobs.claim('worker', { id: job.id });
  const claimed = c.store.jobs.get(job.id);
  c.store.db.prepare("UPDATE jobs SET state='recovery_required',attempts=0 WHERE id=?").run(job.id);
  c.store.db.prepare(`INSERT INTO tool_executions(id,task_id,job_id,provider,tool,action_family,resource_id,is_write,idempotency_key,effect_signature_json,input_version,run_generation,privacy_epoch,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,?,?,1,1,1,'dispatched',?,?)`).run('ex-crashed', current.id, job.id, 'fixture', 'send', 'fixture.send', 'res-crashed', 'k-crashed', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  // The provider can never confirm the outcome, so reconciliation keeps saying unknown.
  c.runtime.ledger.reconcile = async () => ({ status: 'unknown' });
  await c.runtime.recover(c.store.jobs.get(job.id));
  assert.equal(c.store.jobs.get(job.id).state, 'dead', 'the last attempt dead-letters');
  const stopped = c.store.state.tasks[current.id];
  assert.equal(stopped.status, 'blocked', 'an exhausted recovery must not leave the task verifying');
  assert.ok(c.store.state.notifications.some(item => item.dedupeKey === `blocker:${current.id}` && !item.resolvedAt), 'the user must be told');
});
