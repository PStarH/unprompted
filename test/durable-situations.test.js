import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';

const email = (id, body = 'Please update the Cedar proposal with the experiment results and send it by Friday.') => ({
  id: `event:${id}`, type: 'email.received', payload: { id, threadId: 'cedar-thread', from: 'alex@example.test', to: 'reader@example.test', subject: 'Cedar proposal', body, receivedAt: id === 'withdrawal' ? '2026-10-26T11:00:00Z' : '2026-10-26T10:00:00Z' }
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-situation-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime, situations: store.tasks.situations };
}

test('a request creates an evidence-backed Situation and completing a task does not resolve it', async t => {
  const { store, engine, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const task = store.tasks.get('request:initial'), situation = situations.get(task.situationId);
  assert.equal(situation.lifecycle_state, 'OPEN');
  assert.equal(situation.closure_status, 'NONE');
  assert.equal(store.db.prepare('SELECT event_id FROM event_situation_links WHERE situation_id=?').get(situation.id).event_id, 'event:initial');
  store.mutate(state => { state.tasks[task.id].status = 'completed'; });
  assert.equal(situations.get(situation.id).lifecycle_state, 'OPEN');
});

test('a task discovered asynchronously links the original persisted Event and creates a Situation', async t => {
  const { store, engine } = fixture(t);
  const reasoner = Object.assign(new NullReasoner(), { available: () => true,
    async discoverRequestCandidate() { return { deliverable: 'proposal', deliverableQuote: 'proposal', subjectEntity: 'northstar', entityQuote: 'northstar', intent: 'update', intentQuote: 'Please update the proposal', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results' }] }; },
    async interpretRequest() { return null; }, async proposeProbes() { return []; } });
  engine.replaceReasoner(reasoner);
  engine.ingest({ id: 'candidate', type: 'email.received', payload: { id: 'candidate', threadId: 'candidate-thread', from: 'alex@example.test', to: 'reader@example.test', subject: 'proposal update', body: 'Please update the proposal for northstar with experiment results.', receivedAt: '2026-10-25T09:00:00Z' } });
  await engine.whenSettled();
  const task = store.tasks.get('request:candidate');
  assert.ok(task?.situationId);
  assert.equal(store.db.prepare('SELECT event_id FROM task_events WHERE task_id=?').get(task.id).event_id, 'candidate');
  assert.equal(store.db.prepare('SELECT event_id FROM event_situation_links WHERE situation_id=?').get(task.situationId).event_id, 'candidate');
});

test('one Situation admits independent tasks while duplicate active work is idempotent', async t => {
  const { store, engine, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const original = store.tasks.get('request:initial'), situationId = original.situationId;
  const first = store.tasks.createOrLoad({ candidateKey: 'analysis-1', situationId, dedupTaskKey: 'analysis', data: { status: 'waiting_for_information' }, eventId: 'event:initial' });
  const duplicate = store.tasks.createOrLoad({ candidateKey: 'analysis-2', situationId, dedupTaskKey: 'analysis', data: { status: 'waiting_for_information' }, eventId: 'event:initial' });
  const independent = store.tasks.createOrLoad({ candidateKey: 'legal', situationId, dedupTaskKey: 'legal', data: { status: 'waiting_for_information' }, eventId: 'event:initial' });
  assert.equal(duplicate.createdNew, false); assert.equal(duplicate.taskId, first.taskId);
  assert.notEqual(first.taskId, independent.taskId);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE situation_id=?').get(situationId).n, 3);
  assert.equal(situations.get(situationId).lifecycle_state, 'OPEN');
  const finished = store.tasks.get(first.taskId);
  store.tasks.update(finished.id, finished.stateVersion, task => { task.status = 'completed'; });
  const next = store.tasks.createOrLoad({ candidateKey: 'analysis-1', situationId, dedupTaskKey: 'analysis', data: { status: 'waiting_for_information' }, eventId: 'event:initial' });
  assert.equal(next.createdNew, true); assert.notEqual(next.taskId, first.taskId);
});

test('one source event may support distinct Situations without merging them', async t => {
  const { store, engine, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const original = store.tasks.get('request:initial').situationId;
  const separate = situations.create({ kind: 'review', summary: 'Separate review', sourceEventIds: ['event:initial'] });
  assert.notEqual(original, separate.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE event_id=?').get('event:initial').n, 2);
});

test('withdrawal of one task does not cancel a Situation with independent tasks', async t => {
  const { store, engine, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const id = store.tasks.get('request:initial').situationId;
  store.tasks.createOrLoad({ candidateKey: 'legal', situationId: id, dedupTaskKey: 'legal', data: { status: 'waiting_for_information' } });
  assert.equal(engine.ingest(email('withdrawal', 'Please cancel the Cedar proposal request.')).disposition, 'request_withdrawn');
  assert.equal(situations.get(id).lifecycle_state, 'OPEN');
});

test('a confirmed sole-task withdrawal cancels the Situation, with provenance', async t => {
  const { store, engine, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const id = store.tasks.get('request:initial').situationId;
  assert.equal(engine.ingest(email('withdrawal', 'Please cancel the Cedar proposal request.')).disposition, 'request_withdrawn');
  const situation = situations.get(id);
  assert.equal(situation.lifecycle_state, 'CANCELLED');
  assert.deepEqual(situation.closureEvidence, [{ kind: 'event', id: 'event:withdrawal' }]);
});

test('Forget removes Situation summaries and linked tasks derived from the forgotten evidence', async t => {
  const { store, engine, runtime, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const task = store.tasks.get('request:initial'), id = task.situationId;
  assert.ok(situations.get(id));
  const result = await runtime.privacy.forget({ kind: 'event', id: 'event:initial' });
  assert.equal(result.state, 'completed');
  assert.equal(situations.get(id), undefined);
  assert.equal(store.tasks.get(task.id).privacyInvalidated, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(id).n, 0);
});

test('Forget scrubs a Situation while preserving independent evidence and unrelated task work', async t => {
  const { store, engine, runtime, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const first = store.tasks.get('request:initial'), situationId = first.situationId;
  engine.ingest({ ...email('independent', 'The legal review remains pending.'), payload: { ...email('independent', 'The legal review remains pending.').payload, threadId: 'legal-thread' } });
  const independent = store.tasks.createOrLoad({ candidateKey: 'independent-legal', situationId, dedupTaskKey: 'legal', eventId: 'event:independent',
    data: { status: 'waiting_for_information', subject: 'Independent legal review', control: { paused: true } } });
  const result = await runtime.privacy.forget({ kind: 'event', id: 'event:initial' });
  assert.equal(result.state, 'completed');
  assert.equal(store.tasks.get(first.id).privacyInvalidated, true);
  const preserved = store.tasks.get(independent.taskId);
  assert.equal(preserved.subject, 'Independent legal review');
  assert.equal(preserved.privacyInvalidated, undefined);
  assert.equal(preserved.situationId, situationId);
  const situation = situations.get(situationId);
  assert.equal(situation.lifecycle_state, 'OBSERVING');
  assert.equal(situation.summary, 'Evidence-backed matter');
  assert.deepEqual(store.db.prepare('SELECT event_id FROM event_situation_links WHERE situation_id=?').all(situationId).map(row => row.event_id), ['event:independent']);
  assert.equal(store.db.prepare("SELECT status FROM task_signals WHERE task_id=? AND signal_type='SYSTEM_REVOKE_SIGNAL'").get(independent.taskId).status, 'PENDING');
});

test('Forget reconciles an independent in-flight write when its shared Situation is reset', async t => {
  const { store, engine, runtime } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const situationId = store.tasks.get('request:initial').situationId;
  engine.ingest({ ...email('independent', 'Legal review is pending.'), payload: { ...email('independent', 'Legal review is pending.').payload, threadId: 'legal-thread' } });
  await engine.whenSettled(); runtime.suspended = true;
  const task = store.tasks.createOrLoad({ candidateKey: 'legal-write', situationId, dedupTaskKey: 'legal', eventId: 'event:independent', data: { status: 'waiting_for_information', subject: 'Legal review' } });
  const queued = runtime.jobs.list({ taskId: task.taskId }).find(job => job.job_type === 'task_initial');
  const job = runtime.jobs.claim('test-worker', { id: queued.id }), run = runtime.tasks.beginRun(job);
  runtime.tasks.checkpoint(run, job, { expectedInputVersion: runtime.tasks.get(task.taskId).inputVersion, plan: {}, sources: [{ kind: 'event', id: 'event:independent' }] });
  const intent = runtime.ledger.intent({ taskId: task.taskId, run, job, provider: 'fixture', tool: 'write', actionFamily: 'fixture.write', resourceId: 'legal-document', key: 'legal-write-key', effect: { type: 'write' }, payload: {}, authorize: () => ({ allowed: true }) });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const dispatch = runtime.ledger.dispatch(intent, { run, job, send: async () => { started(); await blocked; return { id: 'remote-receipt' }; } });
  await entered;
  await runtime.privacy.forget({ kind: 'event', id: 'event:initial' });
  assert.equal(runtime.ledger.get(intent.execution.id).status, 'unknown');
  assert.equal(store.db.prepare('SELECT claim_state FROM resource_claims WHERE current_execution_id=?').get(intent.execution.id).claim_state, 'unresolved');
  assert.ok(store.db.prepare("SELECT 1 FROM jobs WHERE queue_name='effects' AND job_type='reconcile_execution' AND state='queued'").get());
  release();
  await assert.rejects(dispatch);
  assert.equal(runtime.ledger.get(intent.execution.id).status, 'unknown');
  assert.equal(store.tasks.get(task.taskId).privacyInvalidated, undefined);
});

test('a durable Situation timer triggers reevaluation without an external Event', async t => {
  const { store, engine, runtime, situations } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const task = store.tasks.get('request:initial'), at = new Date(Date.now() - 1000).toISOString();
  const timer = runtime.scheduleSituation(task.situationId, at);
  await runtime.whenIdle();
  assert.equal(runtime.jobs.get(timer.id).state, 'completed');
  assert.equal(situations.get(task.situationId).next_eval_at, null);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM durable_inbox WHERE provider='scheduler'").get().n, 1);
  assert.ok(store.db.prepare("SELECT 1 FROM jobs WHERE job_type='task_continue' AND task_id=? AND idempotency_key=?").get(task.id, `situation-timer:${timer.id}:${task.id}`));
});

test('a taskless observing Situation timer records a wait without invoking a model', async t => {
  const { store, engine, runtime, situations } = fixture(t);
  engine.ingest(email('context', 'The supplier has not provided delivery terms.')); await engine.whenSettled();
  const situation = situations.create({ kind: 'supplier_followup', summary: 'Awaiting delivery terms', sourceEventIds: ['event:context'],
    closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: ['Delivery terms'] } });
  const timer = runtime.scheduleSituation(situation.id, new Date(Date.now() - 1000).toISOString());
  await runtime.whenIdle();
  assert.equal(runtime.jobs.get(timer.id).state, 'completed');
  assert.equal(situations.get(situation.id).lifecycle_state, 'OBSERVING');
  const decision = store.db.prepare("SELECT outcome,reason_code FROM activation_decisions WHERE situation_id=? AND stage='situation_timer'").get(situation.id);
  assert.deepEqual(decision, { outcome: 'WAIT', reason_code: 'no_new_evidence' });
  assert.equal(Object.keys(store.state.tasks).length, 0);
});

test('a superseded Situation schedule cannot fire an obsolete timer', async t => {
  const { store, engine, runtime } = fixture(t);
  engine.ingest(email('initial')); await engine.whenSettled();
  const id = store.tasks.get('request:initial').situationId;
  const old = runtime.scheduleSituation(id, new Date(Date.now() - 2000).toISOString());
  const next = new Date(Date.now() + 3600000).toISOString();
  runtime.scheduleSituation(id, next);
  await runtime.whenIdle();
  assert.equal(runtime.jobs.get(old.id).state, 'completed');
  assert.equal(runtime.tasks.situations.get(id).next_eval_at, next);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM durable_inbox WHERE provider='scheduler'").get().n, 0);
});

test('opening a version-two workspace migrates columns and backfills active sourced tasks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-situation-migration-'));
  const filename = path.join(directory, 'state.json');
  let store = new SqliteStore(filename), engine = new WorkEngine(store);
  engine.ingest(email('initial')); await engine.whenSettled();
  store.database.atomic(() => {
    store.db.exec('DELETE FROM situations; DROP INDEX uq_active_task_dedup; ALTER TABLE tasks DROP COLUMN situation_id; ALTER TABLE tasks DROP COLUMN dedup_task_key');
    store.db.pragma('user_version=2');
  });
  store.close();
  store = new SqliteStore(filename);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const task = store.tasks.get('request:initial');
  assert.ok(task.situationId);
  assert.equal(store.tasks.situations.get(task.situationId).lifecycle_state, 'OPEN');
  assert.equal(store.db.prepare('SELECT event_id FROM event_situation_links WHERE situation_id=?').get(task.situationId).event_id, 'event:initial');
});
